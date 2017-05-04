'use strict';

const db = require('../db');
const config = require('../utils/config');
const packages = require('../utils/packages');
const logger = require('../utils/logger');
const helpers = require('./helpers');
const upload = require('./upload');
const parse = require('../utils/click-parser-async');
const checksum = require('../utils/checksum');
const reviewPackage = require('../utils/review-package');

const passport = require('passport');
const multer  = require('multer');
const cluster = require('cluster');
const fs = require('fs');
const crypto = require('crypto');
const exec = require('child_process').exec;
const bluebird = require('bluebird');
const path = require('path');
const mime = require('mime');

bluebird.promisifyAll(fs);
const mupload = multer({dest: '/tmp'});

const NEEDS_MANUAL_REVIEW = 'This app needs to be reviewed manually';
const MALFORMED_MANIFEST = 'Your package manifest is malformed';
const DUPLICATE_PACKAGE = 'A package with the same name already exists';
const PERMISSION_DENIED = 'You do not have permission to update this app';
const BAD_FILE = 'The file must be a click or snap package';
const WRONG_PACKAGE = 'The uploaded package does not match the name of the package you are editing';
const APP_NOT_FOUND = 'App not found';

function setup(app) {
    app.get('/api/health', function(req, res) {
        helpers.success(res, {
            id: cluster.worker.id
        });
    });

    app.get(['/api/apps', '/repo/repolist.json', '/api/v1/apps'], function(req, res) {
        let query = {published: true};

        if (req.query.types && Array.isArray(req.query.types)) {
            query['types'] = {
                $in: req.query.types,
            };
        }
        else if (req.query.types) {
            query['types'] = req.query.types;
        }
        else {
            query['types'] = {
                $in: ['app', 'webapp', 'scope'],
            };
        }

        if (req.query.frameworks) {
            let frameworks = req.query.frameworks.split(',');
            query.framework = {
                $in: frameworks
            };
        }

        if (req.query.architecture) {
            let architectures = [req.query.architecture];
            if (req.query.architecture != 'all') {
                architectures.push('all');
            }

            query.$or = [
                {architecture: {$in: architectures}},
                {architectures: {$in: architectures}},
            ];
        }

        db.Package.count(query).then((count) => {
            let findQuery = db.Package.find(query);
            findQuery.sort('name');
            if (req.query.limit) {
                findQuery.limit(parseInt(req.query.limit));
            }

            if (req.query.skip) {
                findQuery.skip(parseInt(req.query.skip));
            }

            return Promise.all([
                findQuery,
                count,
            ]);
        }).then((results) => {
            let pkgs = results[0];
            let count = results[1];

            let formatted = [];
            pkgs.forEach(function(pkg) {
                formatted.push(packages.toJson(pkg, req));
            });

            if (req.originalUrl == '/repo/repolist.json') {
                res.send({
                    success: true,
                    message: null,
                    packages: formatted,
                });
            }
            else if (req.originalUrl.substring(0, 12) == '/api/v1/apps') {
                helpers.success(res, {
                    count: count,
                    packages: formatted,
                });
            }
            else {
                helpers.success(res, formatted);
            }
        }).catch((err) => {
            logger.error('Error fetching packages:', err);
            helpers.error(res, 'Could not fetch app list at this time');
        });;
    });

    app.get(['/api/apps/:id', '/api/v1/apps/:id'], function(req, res) {
        let query = {
            published: true,
            id: req.params.id,
        };

        if (req.query.frameworks) {
            let frameworks = req.query.frameworks.split(',');
            query.framework = {
                $in: frameworks
            };
        }

        if (req.query.architecture) {
            let architectures = [req.query.architecture];
            if (req.query.architecture != 'all') {
                architectures.push('all');
            }

            query.$or = [
                {architecture: {$in: architectures}},
                {architectures: {$in: architectures}},
            ];
        }

        db.Package.findOne(query).then((pkg) => {
            if (!pkg) {
                throw APP_NOT_FOUND;
            }

            helpers.success(res, packages.toJson(pkg, req));
        }).catch((err) => {
            if (err == APP_NOT_FOUND) {
                helpers.error(res, err, 404);
            }
            else {
                logger.error('Error fetching packages:', err);
                helpers.error(res, 'Could not fetch app list at this time');
            }
        });;
    });


    app.get('/api/download/:id/:click', function(req, res) {
        db.Package.findOne({id: req.params.id, published: true}).exec(function(err, pkg) {
            if (err) {
                helpers.error(res, err);
            }
            else if (!pkg) {
                helpers.error(res, 'Package not found', 404);
            }
            else {
                var version = 'v' + pkg.version.replace(/\./g, '__');
                var inc = {};
                inc['downloads.' + version] = 1;

                db.Package.update({_id: pkg._id}, {$inc: inc}, function(err) {
                    if (err) {
                        logger.error(err);
                    }
                    else {
                        res.redirect(301, pkg.package);
                    }
                });
            }
        });
    });

    app.get(['/api/icon/:version/:id', '/api/icon/:id'], function(req, res) {
        var id = req.params.id;
        if (id.indexOf('.png') == (id.length - 4)) {
            id = id.replace('.png', '');
        }

        db.Package.findOne({id: id}).then((pkg) => {
            if (!pkg || !pkg.icon) {
                throw '404';
            }

            let filename = `${config.data_dir}/${pkg.version}-${pkg.id}`;
            if (fs.existsSync(filename)) {
                return filename;
            }
            else {
                return helpers.download(pkg.icon, filename);
            }
        }).then((filename) => {
            res.setHeader('Content-type', mime.lookup(filename));
            res.setHeader('Cache-Control', 'public, max-age=2592000'); //30 days
            fs.createReadStream(filename).pipe(res);
        }).catch((err) => {
            logger.error('Failed to download icon', err);

            res.status(404);
            fs.createReadStream(path.join(__dirname, '../404.png')).pipe(res);
        });
    });

    app.get('/api/v1/manage/apps', passport.authenticate('localapikey', {session: false}), function(req, res) {
        let query = null;
        if (helpers.isAdminUser(req)) {
            query = db.Package.find({});
        }
        else {
            query = db.Package.find({maintainer: req.user._id});
        }

        //TODO paging
        query.sort('name').then((pkgs) => {
            let result = pkgs.map((pkg) => {
                return packages.toJson(pkg, req);
            });

            helpers.success(res, result);
        }).catch((err) => {
            logger.error('Error fetching packages:', err);
            helpers.error(res, 'Could not fetch app list at this time');
        });
    });

    app.get('/api/v1/manage/apps/:id', passport.authenticate('localapikey', {session: false}), function(req, res) {
        let query = null;
        if (helpers.isAdminUser(req)) {
            query = db.Package.findOne({id: req.params.id});
        }
        else {
            query = db.Package.findOne({id: req.params.id, maintainer: req.user._id});
        }

        query.then((pkg) => {
            helpers.success(res, packages.toJson(pkg, req));
        }).catch((err) => {
            helpers.error(res, 'App not found', 404);
        });
    });

    function fileName(req) {
        let filePath = req.file.path;
        //Rename the file so click-review doesn't freak out
        if (req.file.originalname.endsWith('.click')) {
            filePath += '.click';
        }
        else {
            filePath += '.snap';
        }

        return filePath;
    }

    function checkPackage(req) {
        if (
            !req.file.originalname.endsWith('.click') &&
            !req.file.originalname.endsWith('.snap')
        ) {
            fs.unlink(req.file.path);
            throw BAD_FILE;
        }
        else {
            return fs.renameAsync(req.file.path, fileName(req)).then(() => {
                if (helpers.isAdminOrTrustedUser(req)) {
                    return false; //Admin & trusted users can upload apps without manual review
                }
                else {
                    return reviewPackage(fileName(req));
                }
            }).then((needsManualReview) => {
                if (needsManualReview) {
                    throw NEEDS_MANUAL_REVIEW;
                };
            });
        }
    }

    function updateAndUpload(results) {
        let pkg = results[0];
        let parseData = results[1];
        pkg.download_sha512 = results[2];
        let req = results[3];

        if (!parseData.name || !parseData.version || !parseData.architecture) {
            throw MALFORMED_MANIFEST;
        }

        if (pkg.id && parseData.name != pkg.id) {
            throw WRONG_PACKAGE;
        }

        packages.updateInfo(pkg, parseData, req.body, req.file);

        return upload.uploadPackage(
            config.smartfile.url,
            config.smartfile.share,
            pkg,
            fileName(req),
            parseData.icon
        );
    }

    app.post(['/api/apps', '/api/v1/manage/apps'], passport.authenticate('localapikey', {session: false}), mupload.single('file'), function(req, res) {
        if (!req.file) {
            helpers.error(res, 'No file upload specified');
        }
        else if (
            !req.file.originalname.endsWith('.click') &&
            !req.file.originalname.endsWith('.snap')
        ) {
            helpers.error(res, BAD_FILE);
            fs.unlink(req.file.path);
        }
        else {
            if (req.body && !req.body.maintainer) {
                req.body.maintainer = req.user._id;
            }

            checkPackage(req).then(() => {
                let parsePromise = parse(fileName(req), true);
                let existingPromise = parsePromise.then((parseData) => {
                    if (!parseData.name || !parseData.version || !parseData.architecture) {
                        throw MALFORMED_MANIFEST;
                    }

                    return db.Package.findOne({id: parseData.name});
                }).then((existing) => {
                    if (existing) {
                        throw DUPLICATE_PACKAGE;
                    }
                });

                return Promise.all([
                    new db.Package(),
                    parsePromise,
                    checksum(fileName(req)),
                    req,
                    existingPromise,
                ]);
            }).then(updateAndUpload)
            .then((pkg) => {
                return pkg.save();
            }).then((pkg) => {
                helpers.success(res, packages.toJson(pkg, req));
            }).catch((err) => {
                if (err == NEEDS_MANUAL_REVIEW || err == MALFORMED_MANIFEST || err == DUPLICATE_PACKAGE) {
                    helpers.error(res, err, 400);
                }
                else {
                    logger.error('Error parsing new package:', err);
                    helpers.error(res, 'There was an error creating your app, please try again later');
                }
            });
        }
    });

    app.put(['/api/apps/:id', '/api/v1/manage/apps/:id'], passport.authenticate('localapikey', {session: false}), mupload.single('file'), function(req, res) {
        let packagePromise = db.Package.findOne({id: req.params.id});

        return packagePromise.then((pkg) => {
            if (helpers.isAdminUser(req) || req.user._id == pkg.maintainer) {
                if (req.file) {
                    return checkPackage(req).then(() => {
                        let filePath = fileName(req);
                        let parsePromise = parse(filePath, true);

                        return Promise.all([
                            packagePromise,
                            parsePromise,
                            checksum(filePath),
                            req,
                        ]);
                    }).then(updateAndUpload)
                    .then((pkg) => {
                        return pkg.save();
                    });
                }
                else {
                    packages.updateInfo(pkg, null, req.body, null);
                    return pkg.save();
                }
            }
            else {
                throw PERMISSION_DENIED;
            }
        }).then((pkg) => {
            helpers.success(res, packages.toJson(pkg, req));
        }).catch((err) => {
            if (err == PERMISSION_DENIED || err == BAD_FILE || err == NEEDS_MANUAL_REVIEW || err == MALFORMED_MANIFEST || err == WRONG_PACKAGE) {
                helpers.error(res, err, 400);
            }
            else {
                logger.error('Error updating package:', err);
                helpers.error(res, 'There was an error updating your app, please try again later');
            }
        });
    });
}

exports.setup = setup;
