var Hapi = require('hapi');
var port = process.env.PORT || 8080;
var server = new Hapi.Server(port, '0.0.0.0');
var fs = require('fs');

server.pack.register([
  {
    plugin: require('../')
  }
], function (err) {
  if (err) {
    throw err;
  }

  server.start(function() {
    console.log('Hapi server started @', server.info.uri);
  });

});
