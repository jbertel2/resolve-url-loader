/*
 * MIT License http://opensource.org/licenses/MIT
 * Author: Ben Holloway @bholloway
 */
'use strict';

var path              = require('path'),
    fs                = require('fs'),
    loaderUtils       = require('loader-utils'),
    camelcase         = require('camelcase'),
    defaults          = require('lodash.defaults'),
    SourceMapConsumer = require('source-map').SourceMapConsumer;

var adjustSourceMap = require('adjust-sourcemap-loader/lib/process');
var valueProcessor = require('./lib/value-processor');
var defaultJoin = require('./lib/default-join');

var PACKAGE_NAME = require('./package.json').name;

/**
 * A webpack loader that resolves absolute url() paths relative to their original source file.
 * Requires source-maps to do any meaningful work.
 * @param {string} content Css content
 * @param {object} sourceMap The source-map
 * @returns {string|String}
 */
function resolveUrlLoader(content, sourceMap) {
  /* jshint validthis:true */

  // details of the file being processed
  var loader = this;

  // a relative loader.context is a problem
  if (/^\./.test(loader.context)) {
    return handleException('webpack misconfiguration', 'loader.context is relative, expected absolute', true);
  }

  // webpack 1: prefer loader query, else options object
  // webpack 2: prefer loader options
  // webpack 3: deprecate loader.options object
  // webpack 4: loader.options no longer defined
  var options = defaults(
    loaderUtils.getOptions(loader),
    !!loader.options && loader.options[camelcase(PACKAGE_NAME)],
    {
      absolute   : false,
      sourceMap  : loader.sourceMap,
      engine     : 'rework',
      fail       : false,
      silent     : false,
      keepQuery  : false,
      attempts   : 1,
      join       : defaultJoin,
      debug      : false,
      root       : null,
      includeRoot: false
    }
  );

  // attempts are discontinued
  if ((options.join === defaultJoin) && (options.attempts !== 1)) {
    return handleException('loader misconfiguration', '"attempts" option now requires "join" function', true);
  }

  // validate join option
  if (typeof options.join !== 'function') {
    return handleException('loader misconfiguration', '"join" option must be a Function', true);
  }

  // validate root directory, where specified
  var resolvedRoot = (typeof options.root === 'string') && path.resolve(options.root) || undefined,
      isValidRoot  = resolvedRoot && fs.existsSync(resolvedRoot) && fs.statSync(resolvedRoot).isDirectory();
  if (options.root && !isValidRoot) {
    return handleException('loader misconfiguration', '"root" option does not resolve to a valid directory', true);
  }

  // loader result is cacheable
  loader.cacheable();

  // incoming source-map
  var sourceMapConsumer, absSourceMap;
  if (sourceMap) {

    // support non-standard string encoded source-map (per less-loader)
    if (typeof sourceMap === 'string') {
      try {
        sourceMap = JSON.parse(sourceMap);
      }
      catch (exception) {
        return handleException('source-map error', 'cannot parse source-map string (from less-loader?)');
      }
    }

    // leverage adjust-sourcemap-loader's codecs to avoid having to make any assumptions about the sourcemap
    //  historically this is a regular source of breakage
    try {
      absSourceMap = adjustSourceMap(loader, {format: 'absolute'}, sourceMap);
    }
    catch (exception) {
      return handleException('source-map error', exception.message);
    }

    // prepare the adjusted sass source-map for later look-ups
    sourceMapConsumer = new SourceMapConsumer(absSourceMap);
  }

  // choose a CSS engine
  var enginePath = /^\w+/.test(options.engine) && path.join(__dirname, 'lib', 'engine', options.engine + '.js');
  var isValidEngine = fs.existsSync(enginePath);
  if (!isValidEngine) {
    return handleException('loader misconfiguration', '"engine" option is not valid', true);
  }

  // process async
  var callback = loader.async();
  Promise
    .resolve(require(enginePath)(loader.resourcePath, content, {
      outputSourceMap: !!options.sourceMap,
      transformDeclaration: valueProcessor(loader.context, options),
      absSourceMap,
      sourceMapConsumer
    }))
    .then(onSuccess)
    .catch(onFailure);

  function onSuccess(reworked) {
    // complete with source-map
    //  source-map sources are relative to the file being processed
    if (options.sourceMap) {
      var finalMap = adjustSourceMap(loader, {format: 'sourceRelative'}, reworked.map);
      callback(null, reworked.content, finalMap);
    }
    else {
      callback(null, reworked.content);
    }
  }

  function onFailure(error) {
    callback(null, handleException('Error in CSS', error));
  }

  /**
   * Push an error for the given exception and return the original content.
   * @param {string} label Summary of the error
   * @param {string|Error} [exception] Optional extended error details
   * @param {boolean} [isCritical] Optionally force display
   * @returns {string} The original CSS content
   */
  function handleException(label, exception, isCritical) {
    var rest = (typeof exception === 'string') ? [exception] :
               (exception instanceof Error) ? [exception.message, exception.stack.split('\n')[1].trim()] :
               [];
    var message = '  resolve-url-loader cannot operate: ' + [label].concat(rest).filter(Boolean).join('\n  ');
    if (isCritical || options.fail) {
      loader.emitError(message);
    }
    else if (!options.silent) {
      loader.emitWarning(message);
    }
    return content;
  }

}

module.exports = resolveUrlLoader;
