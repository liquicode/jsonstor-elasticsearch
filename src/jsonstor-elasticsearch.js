'use strict';

const jsongin = require( '@liquicode/jsongin' );


//---------------------------------------------------------------------
// ***There is no driver, and it was measured rather than preferred.***
//
// `@elastic/elasticsearch` refuses an OpenSearch server twice over - a documented product check,
// and then a vendor media type, `application/vnd.elasticsearch+json; compatible-with=9`, which
// OpenSearch answers 406 to. `@opensearch-project/opensearch` drives both today, but only because
// its client is lenient about a compatibility Elastic is engineering away.
//
// ***Plain HTTP and JSON drives both, and always will***, because the Query DSL and the REST
// surface are the thing the two products actually share. So this adapter is `jsonstor-couchdb`'s
// shape - the family's first driverless adapter - for the same reason and with better evidence.
//
// See jsonx/.plans/wave-5-query-languages.md.


//---------------------------------------------------------------------
// ***An index is a collection, and `IndexName` names it.***
//
// Elasticsearch has no collections inside an index, so one of the two had to give, exactly as it
// did for CouchDB. `DropStorage` is a single DELETE which removes this storage's documents and
// no neighbour's.


//---------------------------------------------------------------------
// ***The index is an index over the document, not the document.***
//
// ***Elasticsearch refuses a document body containing `_id`*** - it is a metadata field - and
// this family's default identifier field is spelled exactly that. So the document cannot be
// stored at the top level, and it travels in a payload:
//
//     { _id:                 String( document[ IdField ] ),   the key, in the metadata
//       jsonstor_sequence:   '00001756...000042',             insertion order
//       jsonstor_document:   { ...the true document... } }    the payload
//
// ***The payload is what `_source` gives back, verbatim.*** That is the property this adapter is
// built on and it is worth stating precisely: Elasticsearch ***coerces on the way into the
// index*** and does not touch `_source`. A document holding the string '10' in a field mapped
// `double` is indexed as 10 and returned as '10'. So the ***answers*** keep full fidelity - an
// absent field stays apart from one holding null, a number does not come back a string - while
// the ***pushdown*** admits more than the criteria does. That is the whole reason
// `ElasticExpression` declares every comparison `broadening` and the residual re-check earns its
// keep here more than anywhere else in the family.


//---------------------------------------------------------------------
// ***A mapping is the Columns model, and `Mappings` is where it is declared.***
//
// The SQL adapters declare typed columns for the fields they want to push down on and leave
// everything else in the payload. An Elasticsearch mapping is that same declaration in another
// vocabulary, and this adapter treats it the same way: ***a field nobody declared is not
// pushable***, so its conditions reach `jsongin` instead. The payload is mapped `dynamic: false`
// so an undeclared field is stored and returned but never indexed, which is what makes that
// promise true rather than merely intended.
//
//     Mappings: [ { Name: 'category', Type: 'keyword' },
//                { Name: 'price',    Type: 'double' } ]
//
// ***`text` is accepted and is never pushed down.*** An analyzed field answers the same for
// 'widget' and 'Widget', which is the analyzer doing its job and the wrong answer for `$eq`.
// Declaring one is how a caller gets full-text search over a field; this adapter simply never
// renders an equality against it. Measured 2026-09-05.
//
// ***A declared column may carry `NullValue`***, which becomes the mapping's `null_value`. It is
// the only way `$exists` can be answered exactly: Elasticsearch does not index a null, so
// without a sentinel a null field and an absent field are the same thing to it.


//---------------------------------------------------------------------
// ***A write is not searchable until the index refreshes, and this adapter always refreshes.***
//
// Elasticsearch is near real time by default: a document is visible about a second after it is
// written. Every suite in this family writes and then immediately reads, so a storage which
// honored the default would fail in a way that looked like flakiness rather than like a setting.
// Every write here passes `refresh=true` and pays for it, which is the honest cost of behaving
// like the rest of the family.


module.exports = {

	AdapterName: 'jsonstor-elasticsearch',
	AdapterDescription: 'Documents are stored on an Elasticsearch or OpenSearch server.',

	GetAdapter: function ( jsonstor, Settings )
	{


		//=====================================================================
		/*
			Settings = {
				Server: '',                          // The name or address of the server.
				Port: 9200,                          // The service port.
				Encrypt: false,                      // Whether to reach the server over https.
				IndexName: '',                       // The index holding this collection.
				UserName: '',                        // The user to connect as. Empty for none.
				Password: '',                        // That user's password. Empty for none.
				PrimaryKey: '_id',                   // The field which is the identifier.
				PayloadField: 'jsonstor_document',   // The field holding the document.
				Mappings: [],                        // The payload fields which are mapped.
			}
		*/
		if ( jsongin.ShortType( Settings ) !== 'o' ) { throw new Error( `This adapter requires a Settings parameter.` ); }
		if ( jsongin.ShortType( Settings.Server ) !== 's' ) { throw new Error( `This adapter requires a Settings.Server string parameter.` ); }
		if ( jsongin.ShortType( Settings.IndexName ) !== 's' ) { throw new Error( `This adapter requires a Settings.IndexName string parameter.` ); }
		if ( !Settings.IndexName.length ) { throw new Error( `Settings.IndexName cannot be empty.` ); }


		//=====================================================================
		const SEQUENCE_FIELD = 'jsonstor_sequence';
		const SEARCH_PAGE_SIZE = 1000;
		const REQUEST_TIMEOUT_MS = 30000;

		// ***The types this adapter will put in a mapping.*** A type it does not know is refused
		// by name rather than sent to the server to be refused there, because the message a
		// caller gets should say which setting to change.
		const MAPPING_TYPES = [ 'keyword', 'text', 'long', 'integer', 'short', 'byte',
			'double', 'float', 'boolean', 'date' ];

		// What a mapped type means to jsongin, for the operand type checks the translator makes.
		const MAPPING_SHORT_TYPES = {
			keyword: 's', text: 's', date: 's',
			long: 'n', integer: 'n', short: 'n', byte: 'n', double: 'n', float: 'n',
			boolean: 'b',
		};


		//=====================================================================
		let Storage = jsonstor.StorageInterface();
		Storage.Settings = jsongin.Clone( Settings );
		if ( jsongin.ShortType( Storage.Settings.Port ) !== 'n' ) { Storage.Settings.Port = 9200; }
		if ( jsongin.ShortType( Storage.Settings.Encrypt ) !== 'b' ) { Storage.Settings.Encrypt = false; }
		if ( jsongin.ShortType( Storage.Settings.UserName ) !== 's' ) { Storage.Settings.UserName = ''; }
		if ( jsongin.ShortType( Storage.Settings.Password ) !== 's' ) { Storage.Settings.Password = ''; }

		// ***PrimaryKey names the identifier and IdField is the deprecated alias.***
		let key_declaration = jsonstor.PrimaryKey.Resolve( Storage.Settings );
		if ( key_declaration.Fields.length > 1 )
		{
			throw new Error( `This adapter does not support a composite PrimaryKey: [${key_declaration.Fields.join( ', ' )}].` );
		}
		Storage.Settings.IdField = key_declaration.Fields.length ? key_declaration.Fields[ 0 ] : '_id';
		Storage.PrimaryKeyInfo = {
			Fields: [ Storage.Settings.IdField ],
			// The key is the Elasticsearch `_id`, which is a string, and the payload carries the
			// true typed value beside it.
			Types: [ 's' ],
			Mutable: false,
			Generated: true,
			// ***The identifier index is the server's own.*** Elasticsearch keys every document
			// by `_id` and enforces it, which is the same answer `jsonstor-indexeddb` gives for
			// the same reason.
			IndexHostedBy: 'database',
		};

		// ***A payload always, unlike CouchDB, and the reason is `_id`.*** There is no useful
		// second configuration: a document stored at the top level could not carry this family's
		// default identifier field at all, because Elasticsearch reserves that name.
		if ( jsongin.ShortType( Storage.Settings.PayloadField ) !== 's' ) { Storage.Settings.PayloadField = 'jsonstor_document'; }
		if ( !Storage.Settings.PayloadField.length ) { throw new Error( `Settings.PayloadField cannot be empty; Elasticsearch reserves [_id] and a document must travel in a payload.` ); }

		if ( jsongin.ShortType( Storage.Settings.Mappings ) !== 'a' ) { Storage.Settings.Mappings = []; }
		for ( let index = 0; index < Storage.Settings.Mappings.length; index++ )
		{
			let mapping = Storage.Settings.Mappings[ index ];
			if ( jsongin.ShortType( mapping ) !== 'o' ) { throw new Error( `Settings.Mappings[${index}] must be an object.` ); }
			if ( jsongin.ShortType( mapping.Name ) !== 's' ) { throw new Error( `Settings.Mappings[${index}].Name must be a string.` ); }
			if ( jsongin.ShortType( mapping.Type ) !== 's' ) { mapping.Type = 'keyword'; }
			if ( MAPPING_TYPES.indexOf( mapping.Type ) < 0 )
			{
				throw new Error( `Settings.Mappings[${index}].Type [${mapping.Type}] is not one of: ${MAPPING_TYPES.join( ', ' )}.` );
			}
		}


		//=====================================================================
		// The transport.
		//=====================================================================


		//---------------------------------------------------------------------
		function base_url()
		{
			let scheme = Storage.Settings.Encrypt ? 'https' : 'http';
			return `${scheme}://${Storage.Settings.Server}:${Storage.Settings.Port}`;
		}


		//---------------------------------------------------------------------
		function authorization_header()
		{
			if ( !Storage.Settings.UserName.length ) { return ''; }
			let credential = `${Storage.Settings.UserName}:${Storage.Settings.Password}`;
			return 'Basic ' + Buffer.from( credential ).toString( 'base64' );
		}


		//---------------------------------------------------------------------
		function index_path()
		{
			return encodeURIComponent( Storage.Settings.IndexName );
		}


		//---------------------------------------------------------------------
		// ***One request, and the status is returned rather than thrown on.***
		//
		// Several statuses are answers rather than failures - a 404 from a search is an index
		// nobody has written to, a 400 `resource_already_exists_exception` from a create is an
		// index which is already there - so the caller decides what a status means. A server
		// which cannot be reached at all still throws, out of `fetch`, which is what
		// `004) Unreachable Storage Tests` requires of every read.
		async function request( Method, Path, Body, ContentType )
		{
			let options = {
				method: Method,
				headers: { 'Accept': 'application/json' },
				signal: AbortSignal.timeout( REQUEST_TIMEOUT_MS ),
			};
			let authorization = authorization_header();
			if ( authorization.length ) { options.headers.Authorization = authorization; }
			if ( typeof Body !== 'undefined' )
			{
				options.headers[ 'Content-Type' ] = ContentType || 'application/json';
				options.body = ( typeof Body === 'string' ) ? Body : JSON.stringify( Body );
			}
			let response = await fetch( `${base_url()}/${Path}`, options );
			let text = await response.text();
			let parsed = null;
			if ( text.length )
			{
				try { parsed = JSON.parse( text ); }
				catch ( error ) { parsed = null; }
			}
			return { Status: response.status, Body: parsed, Text: text };
		}


		//---------------------------------------------------------------------
		// ***Elasticsearch says why, and the message keeps it.*** An error body carries a `type`
		// and a `reason`, and a message reporting only the status would throw away the half
		// which says what to do about it.
		function request_error( What, Response )
		{
			let reason = '';
			if ( Response.Body && Response.Body.error )
			{
				let error = Response.Body.error;
				if ( typeof error === 'string' ) { reason = error; }
				else { reason = `${error.type}: ${error.reason}`; }
			}
			else { reason = Response.Text.slice( 0, 200 ); }
			return new Error( `The Elasticsearch server answered [${Response.Status}] to a ${What} request: ${reason}` );
		}


		//---------------------------------------------------------------------
		// ***The mapping this adapter creates.***
		//
		// The payload is `dynamic: false` so an undeclared field is stored in `_source` and
		// returned, and never indexed - which is what makes "a field nobody declared is not
		// pushable" a property of the index rather than a promise of the translator.
		function index_mapping()
		{
			let properties = {};
			for ( let index = 0; index < Storage.Settings.Mappings.length; index++ )
			{
				let mapping = Storage.Settings.Mappings[ index ];
				let mapped = { type: mapping.Type };
				if ( typeof mapping.NullValue !== 'undefined' ) { mapped.null_value = mapping.NullValue; }
				properties[ mapping.Name ] = mapped;
			}
			let payload = { type: 'object', dynamic: false };
			if ( Object.keys( properties ).length ) { payload.properties = properties; }
			let mappings = { properties: {} };
			mappings.properties[ SEQUENCE_FIELD ] = { type: 'keyword' };
			mappings.properties[ Storage.Settings.PayloadField ] = payload;
			return mappings;
		}


		//---------------------------------------------------------------------
		// ***The index is created on the first write and never on a read.***
		//
		// A read against an index which does not exist is an empty collection, which is what
		// every other adapter answers for a storage nobody has written to yet. Creating one to
		// answer a `Count()` would make a question change the thing it asks about.
		//
		// ***Only a success is remembered.*** A failure cached here would answer for the life of
		// the process, and the failure it would cache is an unreachable server.
		let index_ready = false;
		async function ensure_index()
		{
			if ( index_ready ) { return; }
			let response = await request( 'PUT', index_path(), { mappings: index_mapping() } );
			if ( response.Status === 200 ) { index_ready = true; return; }
			// An index which already exists is the answer this asked for.
			if ( ( response.Status === 400 ) && response.Body && response.Body.error
				&& ( response.Body.error.type === 'resource_already_exists_exception' ) )
			{
				index_ready = true;
				return;
			}
			throw request_error( 'index create', response );
		}


		//=====================================================================
		// The document layout.
		//=====================================================================


		//---------------------------------------------------------------------
		// ***The value which goes in the key.*** The payload is where the identifier keeps its
		// own type; the key holds `String()` of it so the by-id paths compare like with like.
		function id_to_key( Document )
		{
			let value = Document[ Storage.Settings.IdField ];
			if ( ( value === null ) || ( typeof value === 'undefined' ) ) { return null; }
			return '' + value;
		}


		//---------------------------------------------------------------------
		function document_to_source( Document, Sequence )
		{
			let source = {};
			source[ Storage.Settings.PayloadField ] = jsongin.Clone( Document );
			if ( typeof Sequence === 'string' ) { source[ SEQUENCE_FIELD ] = Sequence; }
			return source;
		}


		//---------------------------------------------------------------------
		// ***The document as the caller gets it back, which is `_source` verbatim.***
		function source_to_document( Source )
		{
			if ( jsongin.ShortType( Source ) !== 'o' ) { return {}; }
			let payload = Source[ Storage.Settings.PayloadField ];
			if ( jsongin.ShortType( payload ) !== 'o' ) { return {}; }
			return jsongin.Clone( payload );
		}


		//---------------------------------------------------------------------
		// ***A counter which makes a sequence unique inside one process.*** The same shape
		// `jsonstor-couchdb`, `jsonstor-redis` and `jsonstor-leveldb` use, padded to fixed
		// widths because a variable width field sorts differently than it was written.
		let key_sequence = 0;
		function new_sequence()
		{
			let hr_time = process.hrtime();
			let milliseconds = String( ( new Date() ).getTime() ).padStart( 14, '0' );
			let hr_seconds = String( hr_time[ 0 ] ).padStart( 10, '0' );
			let hr_nanoseconds = String( hr_time[ 1 ] ).padStart( 9, '0' );
			key_sequence = ( key_sequence + 1 ) % 1000000;
			let sequence = String( key_sequence ).padStart( 6, '0' );
			return `${milliseconds}.${hr_seconds}.${hr_nanoseconds}.${sequence}`;
		}


		//---------------------------------------------------------------------
		// ***The identifier is written on insert and never again.***
		function with_identifier( Document )
		{
			let document = jsongin.Clone( Document );
			if ( typeof document[ Storage.Settings.IdField ] === 'undefined' )
			{
				document[ Storage.Settings.IdField ] = jsonstor.NewUniqueID();
			}
			return document;
		}


		//=====================================================================
		// The translator.
		//=====================================================================


		//---------------------------------------------------------------------
		// ***What this adapter tells the translator about its mapping.***
		//
		// A declared column is pushable; everything else is absent from this table and is
		// therefore left to jsongin. `analyzed` and `null_sentinel` are the two facts the
		// translator cannot get anywhere else - see `ElasticExpression`.
		function translator_options()
		{
			let allowed = {};
			for ( let index = 0; index < Storage.Settings.Mappings.length; index++ )
			{
				let mapping = Storage.Settings.Mappings[ index ];
				let entry = { short_type: MAPPING_SHORT_TYPES[ mapping.Type ] || '' };
				if ( mapping.Type === 'text' ) { entry.analyzed = true; }
				if ( typeof mapping.NullValue !== 'undefined' ) { entry.null_sentinel = mapping.NullValue; }
				allowed[ mapping.Name ] = entry;
			}
			return { AllowedFields: allowed };
		}


		//---------------------------------------------------------------------
		function translate( Criteria )
		{
			return jsonstor.ElasticExpression.Translate( {
				Criteria: Criteria,
				Options: translator_options(),
			} );
		}


		//---------------------------------------------------------------------
		// ***A field path in a criteria is not a field path in the stored document.***
		//
		// The document travels in a payload, so a query which asks about `price` has to ask
		// about `jsonstor_document.price`. `jsonstor-couchdb` rewrites its selector for exactly
		// this reason and this is the same move in the other language.
		//
		// ***The set of clause shapes below is closed by the translator***, not by Query DSL at
		// large: `ElasticExpression` emits these seven and nothing else, so a shape which
		// arrives here unrecognized is a translator change which forgot this function. It is
		// returned untouched rather than guessed at.
		function map_field_path( Path )
		{
			return `${Storage.Settings.PayloadField}.${Path}`;
		}


		//---------------------------------------------------------------------
		function map_query( Query )
		{
			if ( jsongin.ShortType( Query ) !== 'o' ) { return Query; }

			if ( Query.bool )
			{
				let bool = {};
				let clauses = [ 'filter', 'should', 'must', 'must_not' ];
				for ( let index = 0; index < clauses.length; index++ )
				{
					let name = clauses[ index ];
					if ( typeof Query.bool[ name ] === 'undefined' ) { continue; }
					let value = Query.bool[ name ];
					if ( jsongin.ShortType( value ) === 'a' )
					{
						let mapped = [];
						for ( let child = 0; child < value.length; child++ )
						{
							mapped.push( map_query( value[ child ] ) );
						}
						bool[ name ] = mapped;
					}
					else { bool[ name ] = map_query( value ); }
				}
				if ( typeof Query.bool.minimum_should_match !== 'undefined' )
				{
					bool.minimum_should_match = Query.bool.minimum_should_match;
				}
				return { bool: bool };
			}

			if ( Query.exists )
			{
				return { exists: { field: map_field_path( Query.exists.field ) } };
			}

			let single_field = [ 'term', 'terms', 'range', 'regexp' ];
			for ( let index = 0; index < single_field.length; index++ )
			{
				let name = single_field[ index ];
				if ( typeof Query[ name ] === 'undefined' ) { continue; }
				let mapped = {};
				for ( let field in Query[ name ] )
				{
					mapped[ map_field_path( field ) ] = Query[ name ][ field ];
				}
				let clause = {};
				clause[ name ] = mapped;
				return clause;
			}

			// match_all, and anything a future translator adds without telling this function.
			return Query;
		}


		//---------------------------------------------------------------------
		function report_scan( Options, Translation, Scanned, Matched )
		{
			jsonstor.ReportStatistics( Options, {
				Translator: 'ElasticExpression',
				Pushdown: Translation.Pushdown,
				PushdownRows: Scanned,
				Residual: Translation.Residual,
				ResidualRows: Matched,
			} );
			return;
		}


		//=====================================================================
		// Reading.
		//=====================================================================


		//---------------------------------------------------------------------
		// ***Every document the pushdown admits, paged with `search_after`.***
		//
		// ***`from`/`size` paging stops at ten thousand documents***, which is a setting
		// (`index.max_result_window`) rather than a limit, and raising it on someone's index to
		// answer a `FindMany` would be this adapter reconfiguring a server it did not create.
		// `search_after` has no ceiling and needs no setting, and the sort it pages on is the
		// sequence field this adapter writes - which is the natural order anyway.
		//
		// ***The sequence is the whole sort, with no tie-break beside it, and that is forced.***
		// The obvious second key is `_id`, and Elasticsearch refuses to sort on it:
		// *Fielddata access on the _id field is disallowed*, re-enabled only by the cluster-wide
		// `indices.id_field_data.enabled`. Turning that on would be this adapter reconfiguring
		// someone's cluster for its own convenience - the same objection as raising
		// `max_result_window`, one scope worse.
		//
		// ***It costs nothing, because the sequence is already unique.*** It carries the
		// millisecond, `hrtime` seconds and nanoseconds, and a per-process counter - the same
		// construction `jsonstor-couchdb`, `jsonstor-redis` and `jsonstor-leveldb` order
		// themselves by. `search_after` needs the sort values to identify one document, and one
		// unique key does that as well as two.
		async function run_search( Query )
		{
			let documents = [];
			let after = null;
			while ( true )
			{
				let body = {
					size: SEARCH_PAGE_SIZE,
					query: Query,
					sort: [ { [ SEQUENCE_FIELD ]: 'asc' } ],
				};
				if ( after ) { body.search_after = after; }
				let response = await request( 'POST', `${index_path()}/_search`, body );
				// An index nobody has written to is an empty collection.
				if ( response.Status === 404 ) { return documents; }
				if ( response.Status !== 200 ) { throw request_error( 'search', response ); }
				let hits = ( response.Body && response.Body.hits && Array.isArray( response.Body.hits.hits ) )
					? response.Body.hits.hits : [];
				for ( let index = 0; index < hits.length; index++ )
				{
					documents.push( hits[ index ] );
				}
				if ( hits.length < SEARCH_PAGE_SIZE ) { break; }
				after = hits[ hits.length - 1 ].sort;
				if ( !after ) { break; }
			}
			return documents;
		}


		//---------------------------------------------------------------------
		// ***The documents this criteria admits, in natural order, each with its key.***
		//
		// The pushdown narrows what travels and jsongin decides what matches. ***The residual is
		// almost never null here***, which is correct rather than disappointing: a coercing index
		// cannot settle a typed comparison by itself.
		async function find_entries( Criteria )
		{
			let translation = translate( Criteria );

			// ***A malformed criteria is refused before anything is read***, so the refusal does
			// not depend on the collection holding something.
			if ( translation.Residual !== null ) { jsongin.Query( {}, translation.Residual ); }

			// See id_lookup_key. The residual is left in place on purpose.
			let key = id_lookup_key( Criteria );
			if ( key !== null )
			{
				translation = { Pushdown: { ids: { values: [ key ] } }, Residual: Criteria };
			}

			let hits = await run_search( map_query( translation.Pushdown ) );
			let entries = [];
			for ( let index = 0; index < hits.length; index++ )
			{
				let hit = hits[ index ];
				let document = source_to_document( hit._source );
				if ( translation.Residual !== null )
				{
					if ( !jsongin.Query( document, translation.Residual ) ) { continue; }
				}
				entries.push( {
					Key: hit._id,
					Sequence: hit._source ? hit._source[ SEQUENCE_FIELD ] : '',
					Document: document,
				} );
			}
			// The search already sorted on the sequence, so the natural order arrived with the
			// documents rather than being imposed on them here.
			return { Entries: entries, Scanned: hits.length, Translation: translation };
		}


		//---------------------------------------------------------------------
		// ***A lookup by the identifier is answered from the key, not by a search.***
		//
		// The identifier is the Elasticsearch `_id` and lives in the metadata rather than in the
		// payload, so it is not a mapped field and `ElasticExpression` never renders a condition
		// on it - the criteria would scan the collection. This adapter declares
		// `IndexHostedBy: 'database'`, which promises the server answers a key lookup, and this
		// is where that promise is kept.
		//
		// ***Only the plain equality shape, and deliberately only that.*** A range or a pattern
		// over `_id` has no `ids` query to become, and Elasticsearch refuses to sort or filter
		// on `_id` as an ordinary field anyway. Anything else falls through to the search.
		//
		// ***The residual still re-checks it***, which is what makes the shortcut safe: the key
		// is `String( )` of the identifier, so a collection holding both `1` and `'1'` answers
		// the same key for both and jsongin discards the one the criteria did not ask for.
		function id_lookup_key( Criteria )
		{
			if ( jsongin.ShortType( Criteria ) !== 'o' ) { return null; }
			let keys = Object.keys( Criteria );
			if ( keys.length !== 1 ) { return null; }
			if ( keys[ 0 ] !== Storage.Settings.IdField ) { return null; }
			let value = Criteria[ keys[ 0 ] ];
			if ( !'nsb'.includes( jsongin.ShortType( value ) ) ) { return null; }
			return '' + value;
		}


		//---------------------------------------------------------------------
		async function find_first( Criteria )
		{
			let search = await find_entries( Criteria );
			if ( search.Entries.length ) { return { Search: search, Found: search.Entries[ 0 ] }; }
			return { Search: search, Found: null };
		}


		//---------------------------------------------------------------------
		function criteria_matches_everything( Criteria )
		{
			let short_type = jsongin.ShortType( Criteria );
			if ( 'lu'.includes( short_type ) ) { return true; }
			if ( Object.keys( Criteria ).length === 0 ) { return true; }
			return false;
		}


		//---------------------------------------------------------------------
		function check_criteria( Criteria )
		{
			let short_type = jsongin.ShortType( Criteria );
			if ( !'olu'.includes( short_type ) ) { throw new Error( `Criteria must be an object, null, or undefined.` ); }
			return;
		}


		//=====================================================================
		// Writing.
		//=====================================================================


		//---------------------------------------------------------------------
		// ***One `_bulk` per operation, and it always refreshes.***
		//
		// `_bulk` is newline delimited JSON with a trailing newline, and it answers 200 whether
		// or not every item succeeded - each item carries its own outcome. A caller which read
		// only the status would report a write which did not happen.
		//
		// ***`refresh=true` is not a tuning choice here.*** See the note at the top of this
		// file: without it a document written now is not searchable for about a second, and
		// every suite in this family writes and then immediately reads.
		async function write_bulk( Actions )
		{
			if ( !Actions.length ) { return; }
			await ensure_index();
			let lines = [];
			for ( let index = 0; index < Actions.length; index++ )
			{
				let action = Actions[ index ];
				let header = {};
				header[ action.Operation ] = { _index: Storage.Settings.IndexName, _id: action.Key };
				lines.push( JSON.stringify( header ) );
				if ( action.Operation !== 'delete' ) { lines.push( JSON.stringify( action.Source ) ); }
			}
			let body = lines.join( '\n' ) + '\n';
			let response = await request( 'POST', `_bulk?refresh=true`, body, 'application/x-ndjson' );
			if ( response.Status !== 200 ) { throw request_error( 'bulk write', response ); }
			let items = ( response.Body && Array.isArray( response.Body.items ) ) ? response.Body.items : [];
			for ( let index = 0; index < items.length; index++ )
			{
				let item = items[ index ];
				let outcome = item.index || item.delete || item.create || item.update || {};
				// ***A delete which found nothing is not a failure.*** It is the answer for a
				// document another operation removed first.
				if ( outcome.error )
				{
					// ***A duplicate identifier is refused by name.*** Elasticsearch reports it
					// as a version conflict, which is the truth about its mechanism and says
					// nothing to a caller who wrote the same key twice.
					if ( outcome.error.type === 'version_conflict_engine_exception' )
					{
						throw new Error( `A document with the primary key [${outcome._id}] already exists in [${Storage.Settings.IndexName}].` );
					}
					throw new Error( `The Elasticsearch server refused a document during a bulk write: ${outcome.error.type}: ${outcome.error.reason}` );
				}
			}
			return;
		}


		//---------------------------------------------------------------------
		// ***What to write so that one existing document becomes another.***
		//
		// ***The key is the identifier, so a write which changes it is a move.*** In place when
		// the identifier is unchanged; otherwise the old document is removed and the new one
		// written in the same bulk, so the collection never holds both. The sequence is carried
		// over either way, because a document keeps its place in the natural order.
		function stage_replacement( Entry, Document )
		{
			let key = id_to_key( Document );
			if ( key === Entry.Key )
			{
				return [ { Operation: 'index', Key: key, Source: document_to_source( Document, Entry.Sequence ) } ];
			}
			return [
				{ Operation: 'delete', Key: Entry.Key },
				{ Operation: 'index', Key: key, Source: document_to_source( Document, Entry.Sequence ) },
			];
		}


		//=====================================================================
		// StorageInfo
		//=====================================================================


		// ***What this storage is actually talking to.*** The welcome document at the root
		// carries the server's own version and its distribution, and needs no index to exist.
		//
		// ***The distribution is what tells the two products apart***, and it is the only
		// reliable way: an OpenSearch root response carries `version.distribution: 'opensearch'`
		// where an Elasticsearch one has no such field, and the header differs too -
		// `X-elastic-product: Elasticsearch` against `X-OpenSearch-Version`.
		Storage.StorageInfo = async function ( Options )
		{
			let response = await request( 'GET', '' );
			if ( response.Status !== 200 ) { throw request_error( 'server info', response ); }
			let version = '';
			let product = 'Elasticsearch';
			if ( response.Body && response.Body.version )
			{
				version = String( response.Body.version.number || '' );
				if ( response.Body.version.distribution === 'opensearch' ) { product = 'OpenSearch'; }
			}
			check_product_floor( product, version );
			return jsonstor.BuildStorageInfo( Storage, {
				Product: product,
				Version: version,
				Endpoint: base_url(),
			} );
		};


		//---------------------------------------------------------------------
		// ***Two products number independently, and a floor is a number.***
		//
		// This is the check which says so per product, and it runs ***before*** the family's
		// own `CheckDialectBoundary` so that the message names the right product and the right
		// floor. Both floors were measured on 2026-09-05 - see
		// jsonx/.plans/wave-5-query-languages.md.
		//
		// ***The family check alone could not do this, and the reason is worth recording.***
		// It resolves a profile by comparing the server's version against every prime's, and
		// OpenSearch 1.3 through 3.8 all sit numerically ***below*** the Elasticsearch floor of
		// 7.17 while behaving identically to it. One prime would refuse three servers this
		// adapter is measured against; two primes resolve correctly but would let an
		// Elasticsearch 6.8 land on the OpenSearch profile, because 6.8 is also above 1.3.
		// ***So there are two primes for the resolution and this check for the diagnosis***, and
		// the pairing is what makes both right.
		const PRODUCT_FLOORS = {
			Elasticsearch: [ 7, 17 ],
			OpenSearch: [ 1, 3 ],
		};
		function check_product_floor( Product, Version )
		{
			let floor = PRODUCT_FLOORS[ Product ];
			if ( !floor ) { return; }
			let parts = String( Version ).split( '.' );
			let major = Number( parts[ 0 ] ) || 0;
			let minor = Number( parts[ 1 ] ) || 0;
			if ( major > floor[ 0 ] ) { return; }
			if ( ( major === floor[ 0 ] ) && ( minor >= floor[ 1 ] ) ) { return; }
			let error = new Error( `This storage is connected to ${Product} [${Version}], which is older than [${floor.join( '.' )}] - the oldest ${Product} this package has been measured against.` );
			error.DialectBoundary = true;
			throw error;
		}


		//---------------------------------------------------------------------
		// ***The floor is checked against the server once, on the first operation.***
		//
		// The transport is stateless and `GetStorage` is synchronous, so a server below the
		// floor cannot be caught at construction and surfaces on the first operation instead.
		// A crossed boundary is remembered; a server which did not answer is not.
		let floor_check = null;
		async function ensure_floor_checked()
		{
			if ( floor_check !== null )
			{
				if ( floor_check.Error ) { throw floor_check.Error; }
				return;
			}
			floor_check = {};
			try { await Storage.StorageInfo(); }
			catch ( error )
			{
				if ( error && error.DialectBoundary ) { floor_check.Error = error; }
				else { floor_check = null; }
				throw error;
			}
			return;
		}


		//=====================================================================
		// DropStorage
		//=====================================================================


		Storage.DropStorage = async function ( Options )
		{
			await ensure_floor_checked();
			let response = await request( 'DELETE', index_path() );
			// The next write creates it again.
			index_ready = false;
			if ( ( response.Status === 200 ) || ( response.Status === 404 ) ) { return true; }
			throw request_error( 'index drop', response );
		};


		//=====================================================================
		// FlushStorage
		//=====================================================================


		// ***A flush is a real operation here, unlike CouchDB's.*** It commits the transaction
		// log to disk. An index which does not exist has nothing to flush and says so with a
		// 404, which is an answer.
		Storage.FlushStorage = async function ( Options )
		{
			await ensure_floor_checked();
			let response = await request( 'POST', `${index_path()}/_flush` );
			if ( ( response.Status === 200 ) || ( response.Status === 404 ) ) { return true; }
			throw request_error( 'flush', response );
		};


		//=====================================================================
		// RefreshIndex
		//=====================================================================


		// ***This one has something to do, where most adapters' is a no-op.*** A refresh is what
		// makes written documents searchable. Every write here already asks for one, so this is
		// a caller's way to be certain rather than a repair.
		Storage.RefreshIndex = async function ( Options )
		{
			await ensure_floor_checked();
			let response = await request( 'POST', `${index_path()}/_refresh` );
			if ( ( response.Status !== 200 ) && ( response.Status !== 404 ) ) { throw request_error( 'refresh', response ); }
			return 0;
		};


		//=====================================================================
		// Count
		//=====================================================================


		Storage.Count = async function ( Criteria, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();

			// ***An unfiltered count never reads a document.*** `_count` is this medium's
			// version of the cheap answer every other adapter's count of everything gets.
			if ( criteria_matches_everything( Criteria ) )
			{
				let response = await request( 'GET', `${index_path()}/_count` );
				if ( response.Status === 404 )
				{
					report_scan( Options, translate( Criteria ), 0, 0 );
					return 0;
				}
				if ( response.Status !== 200 ) { throw request_error( 'count', response ); }
				let counted = Number( response.Body.count ) || 0;
				report_scan( Options, translate( Criteria ), counted, counted );
				return counted;
			}

			let search = await find_entries( Criteria );
			report_scan( Options, search.Translation, search.Scanned, search.Entries.length );
			return search.Entries.length;
		};


		//=====================================================================
		// InsertOne
		//=====================================================================


		Storage.InsertOne = async function ( Document, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			if ( jsongin.ShortType( Document ) !== 'o' ) { throw new Error( `Document must be an object.` ); }
			await ensure_floor_checked();
			let document = with_identifier( Document );
			// ***`create` rather than `index`, and that is the primary key contract.***
			// `index` overwrites a document with the same identifier; `create` refuses it. This
			// adapter declares `IndexHostedBy: 'database'`, which says the server enforces the
			// key - so it has to be asked to.
			await write_bulk( [ {
				Operation: 'create',
				Key: id_to_key( document ),
				Source: document_to_source( document, new_sequence() ),
			} ] );
			if ( Options.ReturnDocuments ) { return document; }
			return 1;
		};


		//=====================================================================
		// InsertMany
		//=====================================================================


		Storage.InsertMany = async function ( Documents, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			if ( jsongin.ShortType( Documents ) !== 'a' ) { throw new Error( `Documents must be an array of objects.` ); }
			await ensure_floor_checked();
			let inserted = [];
			let actions = [];
			for ( let index = 0; index < Documents.length; index++ )
			{
				let document = with_identifier( Documents[ index ] );
				inserted.push( document );
				actions.push( {
					Operation: 'create',
					Key: id_to_key( document ),
					Source: document_to_source( document, new_sequence() ),
				} );
			}
			await write_bulk( actions );
			if ( Options.ReturnDocuments ) { return inserted; }
			return inserted.length;
		};


		//=====================================================================
		// FindOne
		//=====================================================================


		Storage.FindOne = async function ( Criteria, Projection, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			let search = await find_first( Criteria );
			let document = null;
			if ( search.Found ) { document = jsongin.Project( search.Found.Document, Projection ); }
			report_scan( Options, search.Search.Translation, search.Search.Scanned, document ? 1 : 0 );
			return document;
		};


		//=====================================================================
		// FindMany
		//=====================================================================


		Storage.FindMany = async function ( Criteria, Projection, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			let search = await find_entries( Criteria );
			let documents = [];
			for ( let index = 0; index < search.Entries.length; index++ )
			{
				documents.push( jsongin.Project( search.Entries[ index ].Document, Projection ) );
			}
			report_scan( Options, search.Translation, search.Scanned, documents.length );
			return documents;
		};


		//=====================================================================
		// FindMany2
		//=====================================================================


		// ***The sort and the limit are applied here rather than by the server.***
		//
		// Elasticsearch can sort, but only on mapped fields - and a criteria may sort on any
		// field in the payload, mapped or not. `ElasticExpression` reports `SortAbsorbed: false`,
		// so this is the translator's declaration carried out rather than a shortcut around it.
		Storage.FindMany2 = async function ( Criteria, Projection, Sort, Paging, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			let search = await find_entries( Criteria );
			let documents = [];
			for ( let index = 0; index < search.Entries.length; index++ )
			{
				documents.push( jsongin.Project( search.Entries[ index ].Document, Projection ) );
			}
			if ( Sort ) { documents = jsongin.Sort( documents, Sort ); }
			documents = jsonstor.Paging.Apply( documents, Paging );
			report_scan( Options, search.Translation, search.Scanned, documents.length );
			return documents;
		};


		//=====================================================================
		// UpdateOne
		//=====================================================================


		// Refuses an update or a replace which moved the identifier. See
		// jsonx/.plans/primary-keys-and-indexes.md.
		function check_key_move( Before, After )
		{
			if ( Storage.PrimaryKeyInfo.Mutable ) { return; }
			if ( Before === After ) { return; }
			throw new Error( `The primary key [${Storage.Settings.IdField}] is not mutable, and this operation would change it from [${Before}] to [${After}].` );
		}


		Storage.UpdateOne = async function ( Criteria, Updates, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			let search = await find_first( Criteria );
			let modified = null;
			let modified_count = 0;
			if ( search.Found )
			{
				modified = jsongin.Update( search.Found.Document, Updates );
				check_key_move( search.Found.Document[ Storage.Settings.IdField ], modified[ Storage.Settings.IdField ] );
				await write_bulk( stage_replacement( search.Found, modified ) );
				modified_count++;
			}
			if ( Options.ReturnDocuments ) { return modified; }
			return modified_count;
		};


		//=====================================================================
		// UpdateMany
		//=====================================================================


		Storage.UpdateMany = async function ( Criteria, Updates, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			let search = await find_entries( Criteria );
			let modified = [];
			let actions = [];
			for ( let index = 0; index < search.Entries.length; index++ )
			{
				let entry = search.Entries[ index ];
				let document = jsongin.Update( entry.Document, Updates );
				check_key_move( entry.Document[ Storage.Settings.IdField ], document[ Storage.Settings.IdField ] );
				modified.push( document );
				actions = actions.concat( stage_replacement( entry, document ) );
			}
			await write_bulk( actions );
			if ( Options.ReturnDocuments ) { return modified; }
			return modified.length;
		};


		//=====================================================================
		// ReplaceOne
		//=====================================================================


		Storage.ReplaceOne = async function ( Criteria, Document, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			if ( jsongin.ShortType( Document ) !== 'o' ) { throw new Error( `Document must be an object.` ); }
			await ensure_floor_checked();
			let search = await find_first( Criteria );
			let modified = null;
			let modified_count = 0;
			if ( search.Found )
			{
				modified = jsongin.Clone( Document );
				// ***A replacement with no primary key carries the matched document's key over.***
				let key_field = Storage.Settings.IdField;
				if ( typeof modified[ key_field ] === 'undefined' )
				{
					let carried = search.Found.Document[ key_field ];
					if ( typeof carried !== 'undefined' ) { modified[ key_field ] = carried; }
				}
				check_key_move( search.Found.Document[ key_field ], modified[ key_field ] );
				await write_bulk( stage_replacement( search.Found, modified ) );
				modified_count++;
			}
			if ( Options.ReturnDocuments ) { return modified; }
			return modified_count;
		};


		//=====================================================================
		// DeleteOne
		//=====================================================================


		Storage.DeleteOne = async function ( Criteria, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			let search = await find_first( Criteria );
			let deleted = null;
			let deleted_count = 0;
			if ( search.Found )
			{
				deleted = search.Found.Document;
				await write_bulk( [ { Operation: 'delete', Key: search.Found.Key } ] );
				deleted_count++;
			}
			if ( Options.ReturnDocuments ) { return deleted; }
			return deleted_count;
		};


		//=====================================================================
		// DeleteMany
		//=====================================================================


		Storage.DeleteMany = async function ( Criteria, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			let search = await find_entries( Criteria );
			let deleted = [];
			let actions = [];
			for ( let index = 0; index < search.Entries.length; index++ )
			{
				let entry = search.Entries[ index ];
				deleted.push( entry.Document );
				actions.push( { Operation: 'delete', Key: entry.Key } );
			}
			await write_bulk( actions );
			if ( Options.ReturnDocuments ) { return deleted; }
			return deleted.length;
		};


		//=====================================================================
		// ElasticTranslation
		//
		// ***What a Query DSL translating adapter advertises beyond the Storage interface.***
		// Its presence is the capability declaration, the same way `Storage.SqlTranslation` and
		// `Storage.MangoTranslation` are: a suite asks the constructed Storage rather than
		// consulting a list somewhere which could disagree with it. Constructing a Storage opens
		// no connection, so the question is answerable while the server is down.
		//=====================================================================


		Storage.ElasticTranslation = {
			TranslatorName: 'ElasticExpression',
			Options: translator_options(),
			MapQuery: map_query,
		};


		//=====================================================================
		return Storage;
	},

};


//---------------------------------------------------------------------
// ***This package is one prime and a set of aliases, and it serves two products.***
//
// Seven servers were probed on 2026-09-05 - Elasticsearch 6.8.23, 7.17.28, 8.19.21 and 9.5.3,
// OpenSearch 1.3.20, 2.19.6 and 3.8.0 - and ***six of the seven answered every one of jsongin's
// thirty one query operators identically***. So there is one profile, and a second prime would
// assert a difference which does not exist. That is the same reasoning which gave
// `jsonstor-redis` one prime for two products and `jsonstor-couchdb` one for two majors.
//
// ***The floor is 7.17 because 6.8 answers differently, and a floor is measured.*** 6.8 refuses
// the `case_insensitive` parameter on a `regexp` query, which arrived in 7.10, and it has mapping
// types where 7.x does not. Reaching it would cost a dialect profile whose content is a mapping
// shape and a silently case-sensitive `$regex` - and an option which quietly changes what a
// criteria matches is worse than a version nobody supports.
//
// ***7.17 rather than 7.10 because 7.17 is what was run.*** The boundary is probably at 7.10;
// probably is not a measurement, which is why `jsonstor-mongodb`'s floor is 4.4 and not 4.0.
//
// ***There are two primes and they carry the same profile, which is new here.***
//
// Everywhere else in this family a second prime means a second behavior - that is what
// `jsonstor-couchdb` declines to declare and what `jsonstor-mongodb` does declare. These two
// describe identical behavior and exist because ***a floor is a version number, and these two
// products number independently.*** OpenSearch 1.3 is not "older than" Elasticsearch 7.17; the
// two scales have nothing to do with each other, and the family's floor check has only one
// number to compare.
//
// ***The Redis precedent hid this.*** `jsonstor-redis` serves Valkey from a single prime and
// gets away with it only because Valkey's numbers happen to sit above the Redis floor. Here they
// sit below, and the same design would refuse three servers this adapter is measured against.
//
// ***What the pairing costs is one imprecise resolution***, and it is bounded: an Elasticsearch
// server between 1.3 and 7.17 is above the OpenSearch floor by arithmetic and would resolve to
// that profile. `check_product_floor` runs first and refuses it by name, so the arithmetic never
// gets the chance.
//
// See jsonx/.plans/wave-5-query-languages.md and jsonx/.plans/versioned-adapters.md.

const ELASTICSEARCH_V717 = {
	AdapterName: 'jsonstor-elasticsearch-v7.17',
	AdapterDescription: module.exports.AdapterDescription,
	GetAdapter: module.exports.GetAdapter,
	Version: [ 7, 17 ],
	MeasuredTo: [ 9, 5, 3 ],
};

const OPENSEARCH_V13 = {
	AdapterName: 'jsonstor-opensearch-v1.3',
	AdapterDescription: module.exports.AdapterDescription,
	GetAdapter: module.exports.GetAdapter,
	Version: [ 1, 3 ],
	MeasuredTo: [ 3, 8, 0 ],
};

module.exports.Adapters = [ ELASTICSEARCH_V717, OPENSEARCH_V13 ];

// ***The bare name is listed here rather than left on the plugin object***, so `GetStorage`
// reports the prime it resolved to instead of reporting itself as its own profile.
module.exports.Aliases = {
	'jsonstor-elasticsearch': 'jsonstor-elasticsearch-v7.17',
	'jsonstor-elasticsearch-v7': 'jsonstor-elasticsearch-v7.17',
	'jsonstor-elasticsearch-v8': 'jsonstor-elasticsearch-v7.17',
	'jsonstor-elasticsearch-v8.19': 'jsonstor-elasticsearch-v7.17',
	'jsonstor-elasticsearch-v9': 'jsonstor-elasticsearch-v7.17',
	'jsonstor-elasticsearch-v9.5': 'jsonstor-elasticsearch-v7.17',
	// ***OpenSearch carries its own numbering***, so its names resolve to its own prime -
	// which describes the same behavior as the Elasticsearch one. See the note above.
	'jsonstor-opensearch': 'jsonstor-opensearch-v1.3',
	'jsonstor-opensearch-v1': 'jsonstor-opensearch-v1.3',
	'jsonstor-opensearch-v2': 'jsonstor-opensearch-v1.3',
	'jsonstor-opensearch-v2.19': 'jsonstor-opensearch-v1.3',
	'jsonstor-opensearch-v3': 'jsonstor-opensearch-v1.3',
	'jsonstor-opensearch-v3.8': 'jsonstor-opensearch-v1.3',
};
