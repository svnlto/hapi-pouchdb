var handlers = require('./handlers');
var pkg = require('../package.json');
var uuids = require('./utils/uuids');
var PouchDB = require('pouchdb');
var extend = require('extend');
var path = require('path');


module.exports = function (plugin, options, next) {

  var histories  = {};
  var dbs        = {};
  var startTime  = new Date().getTime();

  var Pouch = PouchDB.defaults({
    prefix: path.resolve('data') + '/'
  });

  require('pouchdb-all-dbs')(Pouch);
  Pouch.plugin(require('pouchdb-rewrite'));
  Pouch.plugin(require('pouchdb-list'));
  Pouch.plugin(require('pouchdb-show'));
  Pouch.plugin(require('pouchdb-update'));
  Pouch.plugin(require('pouchdb-validation'));

  var internals = {

    setDBOnReq: function (req, reply) {
      var name = encodeURIComponent(req.params.db);

      if (name in dbs) {
        req.pre.db = dbs[name];
        return reply(dbs[name]);
      } else {

        Pouch.allDbs(function (err, alldbs) {

          if (err) {
            return reply(err)
            .code(500)
            .takeover();
          }

          if (alldbs.indexOf(name) === -1) {
            return reply({
              status: 404,
              error: 'not_found',
              reason: 'no_db_file'
            })
            .code(404)
            .takeover();
          }

          new Pouch(name, function (err, db) {
            if (err) {
              return reply(err)
              .code(412)
              .takeover();
            }

            req.pre.db = db;
            internals.registerDB(name, db);

            return reply(db);
          });

        });

      }

    },

    registerDB: function (name, db) {
      db.installValidationMethods();
      dbs[name] = db;
    },

    hapiReqToCouchDBReq: function (req) {
      return {
        body: req.payload,
        cookie: req.cookies || {},
        headers: req.headers,
        method: req.method,
        peer: req.ip,
        query: req.query
      };
    },

    sendCouchDBResp: function (reply, err, couchResp) {

      if (err) {
        return reply(err).code(err.status);
      }

      var body;

      if (couchResp.base64) {
        body = new Buffer(couchResp.base64, 'base64');
      } else {
        body = couchResp.body;
      }

      return reply(body)
      .header(couchResp.headers)
      .code(couchResp.code);

    }
  };




  plugin.ext('onRequest', function (req, extNext) {

    extNext();

  });

  plugin.route([
    {
    method: 'GET',
    path: '/',
    handler: function (req, reply) {
      reply({
        'hapi-pouchdb': 'Welcome!',
        'version': pkg.version
      });
    }
  },
  {
    method: 'GET',
    path: '/_session',
    handler: function (req, reply) {

      reply({
        'ok': true,
        'userCtx': {
          'name': null,
          'roles':[
            '_admin'
          ]
        },'info':{}});
    }
  },

  {
    method: 'POST',
    path: '/_session',
    handler: function (req, reply) {
      var args = req.payload;

      var username = args.name;
      var password = args.password;

      if (password === password) { // TODO: hash against user doc
        reply({
          ok: true,
          name: username,
          roles: [
            username,
            'confirmed'
          ]
        });
      } else {
        reply().code(401);
      }

    }
  },

  {
    method: 'GET',
    path: '/_utils/{p*}',
    config: handlers.fauxton
  },

  {
    method: 'GET',
    path: '/_config',
    handler: function (req, reply) {
      reply({
        facts: {
          'pouchdb-server has no config': true,
          'if you use pouchdb-server, you are awesome': true
        }
      });
    }
  },
  {
    method: 'GET',
    path: '/_config/{key}/{value*}',
    handler: function (req, reply) {
      reply({
        ok: true,
        'pouchdb-server has no config': true
      });
    }
  },
  {
    method: 'GET',
    path: '/_log',
    handler: function (req, reply) {
      reply('_log is not implemented yet. PRs welcome!');
    }
  },
  {
    method: 'GET',
    path: '/_stats',
    handler: function (req, reply) {
      reply('_stats is not implemented yet. PRs welcome!');
    }
  },
  {
    method: 'GET',
    path: '/_active_tasks',
    handler: function (req, reply) {
      // TODO: implement
      reply([]);
    }
  },
  {
    method: 'GET',
    path: '/_uuids',
    handler: function (req, reply) {
      var query = req.query;
      var count = parseInt(query.count, 10) || 1;

      reply({
        uuids: uuids(count)
      })
      .header('Cache-Control', 'must-revalidate, no-cache')
      .header('Pragma', 'no-cache');
    }
  },
  {
    method: 'GET',
    path: '/_all_dbs',
    handler: function (req, reply) {
      Pouch.allDbs(function (err, resp) {
        if (err) {
          reply(Pouch.UNKNOWN_ERROR).code(500);
        }

        reply(resp);
      });
    }
  },
  {
    method: 'POST',
    path: '/_replicate',
    handler: function (req, reply) {
      var payload = req.payload;
      var startDate = new Date();

      var source = payload.source;
      var target = payload.target;
      var opts = {
        continuous: !!payload.continuous
      };

      if (payload.filter) {
        opts.filter = payload.filter;
      }

      if (payload.query_params) {
        opts.query_params = payload.query_params;
      }

      Pouch.replicate(source, target, opts)
      .then(function (response) {

        var historyObj = extend(true, {
          start_time: startDate.toJSON(),
          end_time: new Date().toJSON()
        }, response);

        var currentHistories = [];

        if (!/^https?:\/\//.test(source)) {
          histories[source] = histories[source] || [];
          currentHistories.push(histories[source]);
        }

        if (!/^https?:\/\//.test(target)) {
          histories[target] = histories[target] || [];
          currentHistories.push(histories[target]);
        }

        currentHistories.forEach(function (history) {
          // CouchDB caps history at 50 according to
          // http://guide.couchdb.org/draft/replication.html
          history.push(historyObj);
          if (history.length > 50) {
            history.splice(0, 1); // TODO: this is slow, use a stack instead
          }
        });

        response.history = histories[source] || histories[target] || [];
        reply(response);
      }, function (err) {
        reply(err).code(400);
      });

      // if continuous pull replication return 'ok' since we cannot wait for callback
      if (target in dbs && opts.continuous) {
        reply({
          ok : true
        });
      }
    }
  },

  {
    method: 'GET',
    path: '/{db}',
    config: {
      pre: [{
        method: internals.setDBOnReq,
        assign: 'db'
      }],
      handler: function (req, reply) {
        req.pre.db.info(function (err, info) {
          if (err) {
            reply(err).code(404);
          }
          info.instance_start_time = startTime.toString();
          reply(info);
        });
      }
    }
  },

  {
    method: 'POST',
    path: '/{db}',
    config: {
      pre: [{
        method: internals.setDBOnReq,
        assign: 'db'
      }],
      handler: function (req, reply) {
        req.payload._id = uuids(1)[0];
        req.pre.db.put(req.payload, req.query, function (err, response) {
          if (err) {
            return reply(err).code(err.status || 500);
          }
          reply(response).code(201);
        });
      }

    }
  },

  {
    method: 'PUT',
    path: '/{db}',
    handler: function (req, reply) {
      var name = encodeURIComponent(req.params.db);

      if (name in dbs) {
        return reply({
          'error': 'file_exists',
          'reason': 'The database could not be created.'
        }).code(412);
      }

      new Pouch(name, function (err, db) {

        if (err) {
          return reply(err).code(412);
        }

        internals.registerDB(name, db);

        var loc = req.server.info.protocol
        + '://'
        + req.server.info.host + ':' + req.server.info.port
        + '/' + name;

        reply({
          ok: true
        })
        .header('location', loc)
        .code(201);

      });

    }
  },

  {
    method: 'DELETE',
    path: '/{db}',
    handler: function (req, reply) {
      var name = encodeURIComponent(req.params.db);

      Pouch.destroy(name, function (err) {
        if (err) {
          return reply(err).code(err.status || 500);
        }

        delete dbs[name];

        reply({
          ok: true
        });
      });

    }
  },


  {
    method: 'PUT',
    path: '/{db}/{id}',
    config: {
      pre: [{
        method: internals.setDBOnReq,
        assign: 'db'
      }],
      handler: function (req, reply) {

        function onResponse (err, response) {
          if (err) {
            return reply(err).code(err.status || 500);
          }

          var loc = req.server.info.protocol
          + '://'
          + req.server.info.host + ':' + req.server.info.port
          + '/' + req.params.db
          + '/' + response.id;

          reply(response)
          .header('location', loc)
          .code(201);
        }

        if (/^multipart\/related/.test(req.headers['content-type'])) {
          console.log('>>>>>>>>>>>>>>>>>>>>>>>>');
          // multipart, assuming it's also new_edits=false for now

        } else {

          req.payload._id = req.payload._id || req.query.id;

          if (!req.payload._id) {
            req.payload._id = (!!req.params.id && req.params.id !== 'null')
              ? req.params.id
              : null;
          }
          req.pre.db.put(req.payload, req.query, onResponse);

        }
      }

    }
  },

  {
    method: 'GET',
    path: '/{db}/{id}',
    config: {
      pre: [{
        method: internals.setDBOnReq,
        assign: 'db'
      }],
      handler: function (req, reply) {
        req.pre.db.get(req.params.id, req.query, function (err, doc) {
          if (err) {
            return reply(err).code(404);
          }
          reply(doc);
        });
      }

    }
  },

  {
    method: 'DELETE',
    path: '/{db}/{id}',
    config: {
      pre: [{
        method: internals.setDBOnReq,
        assign: 'db'
      }],
      handler: function (req, reply) {
        req.pre.db.get(req.params.id, req.query, function (err, doc) {
          if (err) {
            return reply(err).code(404);
          }
          req.pre.db.remove(doc, function (err, response) {
            if (err) {
              return reply(err).code(404);
            }
            reply(response);
          });
        });
      }

    }
  },

  {
    method: 'COPY',
    path: '/{db}/{id}',
    config: {
      pre: [{
        method: internals.setDBOnReq,
        assign: 'db'
      }],
      handler: function (req, reply) {
        var dest = req.headers.destination;
        var rev;
        var match;

        if (!dest) {
          return reply({
            'error': 'bad_request',
            'reason': 'Destination header is mandatory for COPY.'
          }).code(400);
        }

        if (match = /(.+?)\?rev=(.+)/.exec(dest)) {
          dest = match[1];
          rev = match[2];
        }

        req.pre.db.get(req.params.id, req.query, function (err, doc) {
          if (err) {
            return reply(err).code(err.status);
          }

          doc._id = dest;
          doc._rev = rev;

          req.pre.db.put(doc, function (err, response) {

            if (err) {
              return reply(err).code(err.status);
            }
            reply(response).code(201);
          });
        });
      }

    }
  },

  {
    method: 'POST',
    path: '/{db}/_bulk_docs',
    config: {
      pre: [{
        method: internals.setDBOnReq,
        assign: 'db'
      }],
      handler: function (req, reply) {
        var payload = req.payload;

        //Maybe this should be moved into the leveldb adapter itself? Not sure
        //how uncommon it is for important options to come through in the body
        //https://github.com/daleharvey/pouchdb/issues/435

        var opts = 'new_edits' in payload ? { new_edits: payload.new_edits } : null;

        if (Array.isArray(payload)) {
          return reply({
            error: 'bad_request',
            reason: 'req body must be a JSON object'
          }).code(404);
        }

        req.pre.db.bulkDocs(payload, opts, function (err, response) {
          if (err) {
            return reply(err).code(err.status || 500);
          }
          reply(response).code(201);
        });
      }
    }
  },
  {
    method: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    path: '/{db}/_all_docs',
    config: {
      pre: [{
        method: internals.setDBOnReq,
        assign: 'db'
      }],
      handler: function (req, reply) {
        var method = req.method;

        if (method !== 'get' && method !== 'post') {
          return next();
        }

        //Check that the req body, if present, is an object.
        if (!!req.payload && Array.isArray(req.payload)) {
          return reply(Pouch.BAD_REQUEST).code(400);
        }

        for (var prop in req.payload) {
          req.query[prop] = req.query[prop] || req.payload[prop];
        }

        req.pre.db.allDocs(req.query, function (err, response) {
          if (err) {
            return reply(err).code(400);
          }
          reply(response);
        });

      }
    }
  },
  {
    method: 'GET',
    path: '/{db}/_changes',
    config: {
      pre: [{
        method: internals.setDBOnReq,
        assign: 'db'
      }],
      handler: function (req, reply) {
        var query = req.query;
        // api.changes expects a property `query_params`
        // This is a pretty inefficient way to do it.. Revisit?
        query.query_params = JSON.parse(JSON.stringify(query));

        if (query.feed === 'continuous' || query.feed === 'longpoll') {
          var heartbeatInterval;
          // 60000 is the CouchDB default
          // TODO: figure out if we can make this default less aggressive
          var heartbeat = (typeof query.heartbeat === 'number') ? query.heartbeat : 6000;
          var written = false;
          heartbeatInterval = setInterval(function () {
            written = true;
            reply.send('\n');
          }, heartbeat);

          var cleanup = function () {
            if (heartbeatInterval) {
              clearInterval(heartbeatInterval);
            }
          };

          if (query.feed === 'continuous') {
            query.live = query.continuous = true;
            req.pre.db.changes(query)
            .on('change', function (change) {
              written = true;
              reply.send(JSON.stringify(change) + '\n');
            }).on('error', function (err) {
              if (!written) {
                reply(err).code(err.status || 500);
              } else {
                reply.end();
              }
              cleanup();
            });

          } else { // longpoll

            // first check if there are >0. if so, return them immediately
            query.live = query.continuous = false;
            req.pre.db.changes(query)
            .on('complete', function (complete) {
              if (!complete.results) {
                // canceled, ignore
                cleanup();
              } else if (complete.results.length) {
                written = true;
                reply(JSON.stringify(complete) + '\n');
                cleanup();
              } else { // do the longpolling
                query.live = query.continuous = true;
                var changes = req.pre.db.changes(query)
                .on('change', function (change) {
                  written = true;

                  reply(JSON.stringify({
                    results: [change],
                    last_seq: change.seq
                  }) + '\n');

                  changes.cancel();
                  cleanup();
                }).on('error', function (err) {
                  if (!written) {
                    reply(err).code(err.status || 500);
                  }
                  cleanup();
                });
              }
            }).on('error', function (err) {
              if (!written) {
                reply(err).code(err.status || 500);
              }
              cleanup();
            });
          }
        } else { // straight shot, not continuous
          query.complete = function (err, response) {
            if (err) {
              return reply(err).code(err.status);
            }
            reply(response);
          };

          req.pre.db.changes(query);
        }

      }

    }
  },

  {
    method: 'POST',
    path: '/{db}/_compact',
    config: {
      pre: [{
        method: internals.setDBOnReq,
        assign: 'db'
      }],
      handler: function (req, reply) {
        req.pre.db.compact(function (err, response) {
          if (err) {
            return reply(err).code(500);
          }

          reply(response);
        });
      }
    }
  },

  {
    method: 'POST',
    path: '/{db}/_revs_diff',
    config: {
      pre: [{
        method: internals.setDBOnReq,
        assign: 'db'
      }],
      handler: function (req, reply) {
        req.pre.db.revsDiff(req.payload || {}, function (err, diffs) {
          if (err) {
            return reply(err).code(400);
          }

          reply(diffs);
        });
      }

    }

  },

  {
    method: 'POST',
    path: '/{db}/_temp_view',
    config: {
      pre: [{
        method: internals.setDBOnReq,
        assign: 'db'
      }],
      handler: function (req, reply) {

        var payload = req.payload;
        var query = req.query;

        if (payload.map) {
          payload.map = (new Function('return ' + payload.map))();
        }

        req.query.conflicts = true;
        req.pre.db.query(payload, query, function (err, response) {
          if (err) {
            return reply(err).code(400);
          }
          reply(response);
        });
      }

    }
  },

  {
    method: 'GET',
    path: '/{db}/_design/{id}/_info',
    config: {
      pre: [{
        method: internals.setDBOnReq,
        assign: 'db'
      }],
      handler: function (req, reply) {
        // Dummy data for Fauxton
        reply({
          'name': req.query.id,
          'view_index': 'Not implemented.'
        });
      }

    }

  },

  {
    method: 'GET',
    path: '/{db}/_design/{id}/_view/{view}',
    config: {
      pre: [{
        method: internals.setDBOnReq,
        assign: 'db'
      }],
      handler: function (req, reply) {
        var query = req.params.id + '/' + req.params.view;

        req.pre.db.query(query, req.query, function (err, response) {

          if (err) {
            return reply(err).code(400);
          }

          reply(response);
        });
      }

    }
  },

  {
    method: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    path: '/{db}/_design/{id}/_list/{func}/{view}',
    config: {
      pre: [{
        method: internals.setDBOnReq,
        assign: 'db'
      }],
      handler: function (req, reply) {
        var query = [req.params.id, req.params.func, req.params.view].join('/');
        var opts = internals.hapiReqToCouchDBReq(req);
        req.pre.db.list(query, opts, internals.sendCouchDBResp.bind(null, reply));
      }

    }
  },

  {
    method: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    path: '/{db}/_design/{id}/_show/{func}/{docid?}',
    config: {
      pre: [{
        method: internals.setDBOnReq,
        assign: 'db'
      }],
      handler: function (req, reply) {
        var query = [req.params.id, req.params.func, req.params.docid].join('/');
        var opts = internals.hapiReqToCouchDBReq(req);
        req.pre.db.show(query, opts, internals.sendCouchDBResp.bind(null, reply));
      }

    }
  },

  {
    method: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    path: '/{db}/_design/{id}/_update/{func}/{docid?}',
    config: {
      pre: [{
        method: internals.setDBOnReq,
        assign: 'db'
      }],
      handler: function (req, reply) {
        var query = [req.params.id, req.params.func, req.params.docid].join('/');
        var opts = internals.hapiReqToCouchDBReq(req);
        req.pre.db.update(query, opts, internals.sendCouchDBResp.bind(null, reply));
      }

    }
  },

  // Put a document attachment
  {
    method: 'PUT',
    path: '/{db}/{id}/{attachment*}',
    config: {
      pre: [{
        method: internals.setDBOnReq,
        assign: 'db'
      }],
      payload: {
        output: 'stream',
        parse: true
      },
      handler: function (req, reply) {
        // Be careful not to catch normal design docs or local docs
        if (req.params.id === '_design' || req.params.id === '_local') {
          return next();
        }

        var name = req.params.id;
        var attachment = req.params.attachment;
        var rev = req.query.rev;
        var type = req.headers['content-type'] || 'application/octet-stream';
        var body = new Buffer(req.rawBody || '', 'binary');

        req.pre.db.putAttachment(name, attachment, rev, body, type, function (err, response) {
          if (err) {
            return reply(err).code(409);
          }

          reply(response);
        });
      }

    }
  },

  {
    method: 'GET',
    path: '/{db}/{id}/{attachment*}',
    config: {
      pre: [{
        method: internals.setDBOnReq,
        assign: 'db'
      }],
      handler: function (req, reply) {
        // Be careful not to catch normal design docs or local docs
        if (req.params.id === '_design' || req.params.id === '_local') {
          return next();
        }

        var name = req.params.id;
        var attachment = req.params.attachment;

        req.pre.db.get(req.params.id, req.query, function (err, info) {
          if (err) {
            return reply(err).code(404);
          }

          if (!info._attachments || !info._attachments[attachment]) {
            return reply({
              status: 404,
              error: 'not_found',
              reason: 'missing'
            }).code(404);
          }

          var type = info._attachments[attachment].content_type;

          req.pre.db.getAttachment(name, attachment, function (err, response) {
            if (err) {
              return reply(err).code(409);
            }
            reply(response)
            .header('content-type', type);
          });
        });
      }

    }
  },

  {
    method: 'DELETE',
    path: '/{db}/{id}/{attachment*}',
    config: {
      pre: [{
        method: internals.setDBOnReq,
        assign: 'db'
      }],
      handler: function (req, reply) {
        // Be careful not to catch normal design docs or local docs
        if (req.params.id === '_design' || req.params.id === '_local') {
          return next();
        }

        var name = req.params.id;
        var attachment = req.params.attachment;
        var rev = req.query.rev;

        req.pre.db.removeAttachment(name, attachment, rev, function (err, response) {
          if (err) {
            return reply(err).code(409);
          }
          reply(response);
        });
      }

    }
  },

  ]);

  next();

};

module.exports.attributes = {
  name: 'hapi-pouchdb',
  pkg: require('../package.json')
};

