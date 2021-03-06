var mongoose = require('mongoose'),
    handlers = require('./handlers');

exports = module.exports = Model 

var methods = ['get', 'post', 'put', 'delete'];
var defaultroutes = ['schema'];
var lookup = {
  'get': 'index',
  'getDetail': 'show',
  'put': 'updated',
  'post': 'created',
  'delete': 'deleted',
}
// Regular expression that checks for hex value
var checkForHexRegExp = new RegExp("^[0-9a-fA-F]{24}$");

/**
 * A new Model
 *
 */
function Model(model) {
  var self = this;
  this.resourceName = model.title.toLowerCase(); 
  if (!this.resourceName) throw new Error("Need a resource name");
  this.methods = {};
  model.methods.forEach(function(meth) {
    if ('string' === typeof meth) {
      self.methods[meth] = {};
    } else {
      if (!meth.type) throw new Error("Method object must have a type property");
      self.methods[meth.type] = meth;
    }
  });
  this.schema = model.schema;
  if (!this.schema) throw new Error("Model needs a schema");

  this.Model = mongoose.model(this.resourceName, this.schema);

  this.update = (model.update ? model.update : {});
  this.delete = (model.delete ? model.delete : {});

  this.userroutes = model.routes || {};

  this.templateRoot = model.template || '';
  if (this.templateRoot.substr(-1) == '/') 
    this.templateRoot = this.templateRoot.substr(0, this.templateRoot.length - 1);

  this.populateRoutes();
}

Model.prototype.new = function(model) {
  return new this.Model(model);
}

/**
 * Populates the default routes for CRUD operations and schema definition
 *
 * If a method is not included in the model definition, then no endpoint
 * is made for that method. If no methods are included in the model 
 * definition, then GET is made available by default
 */
Model.prototype.populateRoutes = function() {
  this.routes = {};

  this.addDefaultRoutes();
  this.addSchemaRoutes();
  this.addUserRoutes();
}

/**
 * Adds the default routes for the HTTP methods and one to get the schema
 */
Model.prototype.addDefaultRoutes = function() {
  var self = this;
  methods.forEach(function(meth) {
    if (meth in self.methods) {
      self.methods[meth].handler = handlers[meth];
      self.route(meth, self.methods[meth]);
    }
  });

  defaultroutes.forEach(function(route) {
    self.route(route, handlers[route]);
  });
}

Model.prototype.addSchemaRoutes = function() {
  var self = this;
  this.schema.eachPath(function(pathName, schemaType) {
    if (schemaType.options.type === 'ObjectId') {
      // Right now, getting nested models is the only operation supported
      ['get'].forEach(function(method) {
        self.route(pathName, [method] , handlers[method + 'Path'].call(self, pathName));
      }); 
    }
  });
}

Model.prototype.addUserRoutes = function() {
  for (var route in this.userroutes) {
    this.route(route, this.userroutes[route]);
  };
}

Model.prototype.route = function(path, method, fn) {
  path = path.replace(/\//g, /\./);
  var self = this;
      subPaths = path.split(/\./),
      route = this.routes,
      meths = ['__all__'];
  if (1 === subPaths.length && '' === subPaths[0]) {
    subPaths = [];
  }
  if (2 === arguments.length) {
    fn = method;
    if (!fn.methods && methods.indexOf(subPaths[subPaths.length - 1]) > -1) {
      meths = [subPaths.splice(subPaths.length - 1, 1)];
    }
  } else {
    meths = [method];
  }

  subPaths.forEach(function(sub, i) {
    if (!route[sub]) route[sub] = {};
    route = route[sub];
  });

  if (fn) {
    if (fn.methods) meths = fn.methods;
    meths.forEach(function(meth) { 
      route[meth] = handlers.wrap.call(self, fn);
    });
  }
  return route;
}

Model.prototype.userroute = function(route, fn) {
  this.route(route, fn);
}

Model.prototype.registerRoute = function(meth, path, fn) {
  if (arguments.length === 2) {
    fn = path;
    path = '';
  }
  this.route(path, meth, fn);
}

/**
 * Registers this model to the given app
 *
 * This includes registering endpoints for all the methods desired
 * in the model definition
 *
 */
Model.prototype.register = function(app, url) {
  var self = this;
  app.use(url, function() { self.dispatch.apply(self, arguments); });
}

Model.prototype.dispatch = function(req, res, next) {
  var params = this.parseUrl(req.url.toLowerCase());

  req.url = params.url;
  req.filters = params.filters;
  params.routes.push(req.method.toLowerCase());

  this.send(params.routes, req, res, next);
}

Model.prototype.handle = function(route, filters, data, callback) {
  if (arguments.length === 3) {
    callback = data;
    data = {};
  } else if (arguments.length === 2) {
    callback = filters; 
    filters = [];
    data = {};
  }
  route = route.replace(/\//g, /\./);
  data.format = 'js';
  var req = {
    url: route,
    filters: filters,
    body: data,
    format: 'js',
  } 
  var res = {
    writeHeader: function() { },
    write: function(ret) { callback(ret); },
    send: function() {},
  };
  this.send(route.split(/\./), req, res);
}

Model.prototype.send = function(routes, req, res, next) {
  var handler = this.routes;
  req.quer = this.filter(req.filters, this.Model.find({}));
  req.templatePath = this.template(routes, req.filters);
  routes.forEach(function(route) {
    if (route in handler) handler = handler[route];
    else if (!('__all__' in handler)) {
      handlers.respond(res, 404, handlers.respond404());
      handlers.last(req, res); 
    } 
  });
  if ('__all__' in handler) handler = handler['__all__'];

  if ('function' === typeof handler) {
    return handler.call(this, req, res, next);
  } 

  handlers.respond(res, 404, handlers.respond404());
  handlers.last(req, res);
}

/**
 * Parses the url for a route and a filter
 *
 * Routes are custom endings representing user defined endpoints for specific models
 * Routes can also be automatically generated for foreign keys and nested models
 * Filters filter a queryset
 *
 * If no route is found, '' is returned
 * If no filters are found, [] is returned
 */
Model.prototype.parseUrl = function(url) {
  var query = url.indexOf('?');
  var filters = '',
      urlparts = url.substring(0, ((query > -1) ? query : url.length)).split('/');

  if (urlparts[0] === '') {
    urlparts.splice(0, 1);
  }
  if (urlparts[urlparts.length - 1] === '') {
    urlparts.splice(urlparts.length - 1, 1);
  }

  filters = this.getFilters(urlparts[0]);
  if (filters.length > 0) urlparts.splice(0, 1);

  return {
    filters: filters,
    routes: urlparts,
    url: urlparts.join('/')
  };
}

/**
 * Returns an array of filters to be applied to the queryset
 * Right now it only checks if the filter is a hex id
 *
 * More ways of filtering to come
 */
Model.prototype.getFilters = function(filter) {
  if (checkForHexRegExp.test(filter)) {
    return [
      {key: '_id', val: filter},
    ]
  }
  return [];
}

/**
 * Filters the queryset based on the filter properties in the url
 * 
 * Returns the filtered queryset
 *
 * More advanced filtering to come
 */
Model.prototype.filter = function(filters, quer) {
  filters.forEach(function(filter) {
    if ('val' in filter) {
      quer = quer.where(filter.key, filter.val);
    }
  });
  return quer;
}

Model.prototype.template = function(route2, filters) {
  var route = route2.slice(0); // Make a copy so we don;'t overwrite
  var method = route[route.length - 1];
  if (methods.indexOf(method) > -1) {
    if (this.haveOneModel(filters) && method === 'get') {
      method += 'Detail';
    }
    route[route.length - 1] = lookup[method];
  }
  return route.join('/');
}

Model.prototype.haveOneModel = function(filters) {
  var haveOne = false;
  filters.forEach(function(filter) {
    if ('_id' === filter.key) { 
      haveOne = true; 
      return;
    }
  });
  return haveOne;
}
