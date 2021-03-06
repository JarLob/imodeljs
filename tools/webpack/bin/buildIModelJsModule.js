#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const path = require("path");
const fs = require("fs");
const yargs = require("yargs");
const child_process = require("child_process");
const glob = require("glob");
// Get the arguments using the ubiquitous yargs package.
function getArgs() {
    const args = yargs
        .wrap(120)
        .option("production", {
        alias: ["prod", "p"],
        describe: "Build production version of module",
        default: false,
        type: "boolean"
    })
        .option("verbose", {
        alias: ["v"],
        describe: "Show detail level 1",
        default: false,
        type: "boolean"
    })
        .option("detail", {
        alias: "d",
        options: [0, 1, 2, 3, 4, 5],
        type: "number",
        default: 0,
        describe: "Sets detail level (0 to 4) to reveal more about the build process"
    })
        .option("stats", {
        alias: "s",
        type: "boolean",
        default: false,
        describe: "Creates the webpack stats json file for system modules"
    })
        .help().argv;
    return args;
}
// Utilities  for file system operations
class Utils {
    static readPackageFileContents(packageRoot) {
        const packageFileName = path.resolve(packageRoot, "./package.json");
        if (!fs.existsSync(packageFileName))
            return {};
        const packageFileContents = fs.readFileSync(packageFileName, "utf8");
        return JSON.parse(packageFileContents);
    }
    static symlinkFiles(cwd, source, dest, alwaysCopy, detail) {
        // first we must create the destination directory, if it isn't already there.
        const sourceSpecification = path.resolve(cwd, source);
        let sourceDirectory = path.dirname(sourceSpecification);
        if (sourceDirectory.endsWith("**")) {
            sourceDirectory = sourceDirectory.slice(0, sourceDirectory.length - 3);
        }
        const destinationPath = path.resolve(cwd, dest);
        try {
            Utils.makeDirectoryNoError(destinationPath);
            const found = glob.sync(sourceSpecification, { nodir: true });
            for (const fileName of found) {
                // find it relative to source.
                const relativePath = path.relative(sourceDirectory, fileName);
                const outputPath = path.resolve(destinationPath, relativePath);
                if (fs.existsSync(outputPath)) {
                    if (detail > 3)
                        console.log("  File", outputPath, "already exists");
                }
                else {
                    if (detail > 3)
                        console.log(alwaysCopy ? "  Copying" : "  Symlinking", fileName, "to", outputPath);
                    Utils.makeDirectoryNoError(path.dirname(outputPath));
                    if (alwaysCopy)
                        fs.copyFileSync(fileName, outputPath);
                    else
                        fs.symlinkSync(fileName, outputPath);
                }
            }
        }
        catch (error) {
            return new Result("Symlink or Copy Source Resources", 1, error);
        }
        return new Result("Symlink or Copy Source Resources", 0);
    }
    // we use this where there is a possible race condition where the compiler might be creating directories in parallel to our linking.
    static makeDirectoryNoError(outDirectory) {
        // Note: mkdirSync with option of { recursive: true } did not work on Linux, necessitating this workaround/
        const directoriesToCreate = [];
        // work backwards through the outDirectory to find the first one that exists.
        let thisDirectory = outDirectory;
        try {
            while (!fs.existsSync(thisDirectory)) {
                directoriesToCreate.push(thisDirectory);
                const parsedPath = path.parse(thisDirectory);
                thisDirectory = parsedPath.dir;
            }
            let createDir;
            while (createDir = directoriesToCreate.pop()) {
                fs.mkdirSync(createDir);
            }
        }
        catch (_error) {
            // do nothing on error.
        }
    }
    static moveFile(sourceDirectory, destDirectory, fileName) {
        const sourceFile = path.join(sourceDirectory, fileName);
        if (!fs.existsSync(sourceFile)) {
            console.log("Error: Trying to move file that does not exist", sourceFile);
        }
        const destFile = path.join(destDirectory, fileName);
        fs.renameSync(sourceFile, destFile);
    }
}
// description of each node_module.
class ModuleInfo {
    constructor(isDevelopment, moduleName, destFileName, relativePath, publicResourceDirectory) {
        this.isDevelopment = isDevelopment;
        this.moduleName = moduleName;
        this.publicResourceDirectory = publicResourceDirectory;
        // if relativePath not supplied, it's one of our @bentley modules and we can figure it out.
        this.destFileName = destFileName ? destFileName : moduleName + ".js";
        if (!relativePath) {
            this.relativePath = path.join(moduleName, isDevelopment ? "lib/module/dev" : "lib/module/prod", this.destFileName);
        }
        else {
            this.relativePath = relativePath;
        }
    }
}
// keeps track of each dependent's information.
class DependentInfo {
    constructor(name, packageRoot, parentPackageRoot, externalModule, versionRequested, versionAvailable) {
        this.name = name;
        this.packageRoot = packageRoot;
        this.parentPackageRoot = parentPackageRoot;
        this.externalModule = externalModule;
        this.versionRequested = versionRequested;
        this.versionAvailable = versionAvailable;
    }
}
// class that copies (or symlinks) the external modules needed my iModel.js into the web resources directory.
class ModuleCopier {
    // these are all modules that are listed as external in our webpack configuration, and therefore need to be copied to the web resources directory.
    constructor(_nodeModulesDirectory, _isDevelopment, _detail, _alwaysCopy) {
        this._nodeModulesDirectory = _nodeModulesDirectory;
        this._detail = _detail;
        this._alwaysCopy = _alwaysCopy;
        this._dependentList = [];
        this._externalModules = [
            new ModuleInfo(_isDevelopment, "@bentley/bentleyjs-core", "bentleyjs-core.js", undefined),
            new ModuleInfo(_isDevelopment, "@bentley/geometry-core", "geometry-core.js", undefined),
            new ModuleInfo(_isDevelopment, "@bentley/imodeljs-i18n", "imodeljs-i18n.js", undefined),
            new ModuleInfo(_isDevelopment, "@bentley/imodeljs-clients", "imodeljs-clients.js", undefined),
            new ModuleInfo(_isDevelopment, "@bentley/imodeljs-common", "imodeljs-common.js", undefined),
            new ModuleInfo(_isDevelopment, "@bentley/imodeljs-quantity", "imodeljs-quantity.js", undefined),
            new ModuleInfo(_isDevelopment, "@bentley/imodeljs-frontend", "imodeljs-frontend.js", undefined, "lib/public"),
            new ModuleInfo(_isDevelopment, "@bentley/imodeljs-markup", "imodeljs-markup.js", undefined, "lib/public"),
            new ModuleInfo(_isDevelopment, "@bentley/ui-core", "ui-core.js", undefined, "lib/public"),
            new ModuleInfo(_isDevelopment, "@bentley/ui-components", "ui-components.js", undefined, "lib/public"),
            new ModuleInfo(_isDevelopment, "@bentley/ui-framework", "ui-framework.js", undefined, "lib/public"),
            new ModuleInfo(_isDevelopment, "@bentley/ui-ninezone", "ui-ninezone.js", undefined),
            new ModuleInfo(_isDevelopment, "@bentley/presentation-common", "presentation-common.js", undefined),
            new ModuleInfo(_isDevelopment, "@bentley/presentation-components", "presentation-components.js", undefined, "lib/public"),
            new ModuleInfo(_isDevelopment, "@bentley/presentation-frontend", "presentation-frontend.js", undefined),
            new ModuleInfo(_isDevelopment, "react", undefined, path.join("react", _isDevelopment ? "umd/react.development.js" : "umd/react.production.min.js")),
            new ModuleInfo(_isDevelopment, "react-dnd", undefined, path.join("react-dnd", _isDevelopment ? "dist/ReactDnD.js" : "dist/ReactDnD.min.js")),
            new ModuleInfo(_isDevelopment, "react-dnd-html5-backend", undefined, path.join("react-dnd-html5-backend", _isDevelopment ? "dist/ReactDnDHTML5Backend.js" : "dist/ReactDnDHTML5Backend.min.js")),
            new ModuleInfo(_isDevelopment, "react-dom", undefined, path.join("react-dom", _isDevelopment ? "umd/react-dom.development.js" : "umd/react-dom.production.min.js")),
            new ModuleInfo(_isDevelopment, "react-redux", undefined, path.join("react-redux", _isDevelopment ? "dist/react-redux.js" : "dist/react-redux.min.js")),
            new ModuleInfo(_isDevelopment, "redux", undefined, path.join("redux", _isDevelopment ? "dist/redux.js" : "dist/redux.min.js")),
            new ModuleInfo(_isDevelopment, "inspire-tree", undefined, path.join("inspire-tree", _isDevelopment ? "dist/inspire-tree.js" : "dist/inspire-tree.min.js")),
            new ModuleInfo(_isDevelopment, "lodash", undefined, path.join("lodash", _isDevelopment ? "lodash.js" : "lodash.min.js")),
        ];
    }
    // symlinks the public static files from a module into the output web resources directories.
    symlinkOrCopyPublicStaticFiles(sourcePublicDirectory, outputPublicDirectory) {
        const symlinkSource = `${sourcePublicDirectory}/**/*`;
        Utils.symlinkFiles(process.cwd(), symlinkSource, outputPublicDirectory, this._alwaysCopy, this._detail);
    }
    // checks contents of existing symlink and replaces it if necessary
    ensureSymlink(sourceFile, outFilePath) {
        try {
            if (fs.existsSync(outFilePath)) {
                try {
                    const linkContents = fs.readlinkSync(outFilePath, { encoding: "utf8" });
                    if (linkContents === sourceFile) {
                        if (this._detail > 3)
                            console.log("  File", outFilePath, "already exists");
                        return 0;
                    }
                }
                catch (_error) {
                    // It's not a link, do nothing and let it get deleted.
                }
                if (this._detail > 3)
                    console.log("  Removing existing symlink found in", outFilePath);
                fs.unlinkSync(outFilePath);
            }
            if (this._detail > 3)
                console.log("  Symlinking", sourceFile, "to", outFilePath);
            fs.symlinkSync(sourceFile, outFilePath);
        }
        catch (error) {
            console.log(error);
            return 1;
        }
        return 0; // success
    }
    // symlinks the module file and source map file if available.
    symlinkOrCopyModuleFile(moduleSourceFile, outFilePath) {
        if (this._alwaysCopy) {
            // copy  the module file.
            if (this._detail > 3)
                console.log("  Copying file", moduleSourceFile, "to", outFilePath);
            // if there is a symlink already there, copyFileSync fails, so check for that case.
            if (fs.existsSync(outFilePath))
                fs.unlinkSync(outFilePath);
            fs.copyFileSync(moduleSourceFile, outFilePath);
            // if there's a source map file, link that, too.
            const mapFile = moduleSourceFile + ".map";
            if (fs.existsSync(mapFile)) {
                const outMapFile = outFilePath + ".map";
                if (this._detail > 3)
                    console.log("  Copying file", mapFile, "to", outMapFile);
                // if there is a symlink already there, copyFileSync fails, so check for that case.
                if (fs.existsSync(outMapFile))
                    fs.unlinkSync(outMapFile);
                fs.copyFileSync(mapFile, outMapFile);
            }
        }
        else {
            // symlink the module file.
            this.ensureSymlink(moduleSourceFile, outFilePath);
            // if there's a source map file, link that, too.
            const mapFile = moduleSourceFile + ".map";
            const outMapFile = outFilePath + ".map";
            if (fs.existsSync(mapFile))
                this.ensureSymlink(mapFile, outMapFile);
        }
    }
    // this function adds the dependencies found in package.json that are external modules. Recurses, but only to depth 1.
    findExternalModuleDependents(parentPackageRoot, depth) {
        const packageFileContents = Utils.readPackageFileContents(parentPackageRoot);
        // find new dependents from this packageFileContents
        const newDependents = [];
        for (const dependent in packageFileContents.dependencies) {
            // see if we already have this dependent.
            if (undefined !== this._dependentList.find((existingDependent) => { return (existingDependent.name === dependent); })) {
                continue;
            }
            // we only care about external modules and their dependents that might be external modules.
            for (const externalModule of this._externalModules) {
                if (externalModule.moduleName === dependent) {
                    const dependentPackageRoot = path.resolve(parentPackageRoot, "node_modules", dependent);
                    const dependentPackageContents = Utils.readPackageFileContents(dependentPackageRoot);
                    if (!dependentPackageContents.version) {
                        console.log("  Cannot find version in package.json of dependent:", dependent);
                    }
                    newDependents.push(new DependentInfo(dependent, dependentPackageRoot, parentPackageRoot, externalModule, packageFileContents.dependencies[dependent], dependentPackageContents.version));
                }
            }
        }
        // add the newly discovered dependents to the master list of dependents.
        for (const newDependent of newDependents) {
            this._dependentList.push(newDependent);
        }
        // we need to check the first level of dependents of our direct dependents to find the non-imodeljs dependencies like lodash, react, redux, etc.
        if (depth < 2) {
            for (const newDependent of newDependents) {
                this.findExternalModuleDependents(newDependent.packageRoot, depth + 1);
            }
        }
    }
    // finds peerDependencies and makes sure they are in the list of dependencies.
    checkPeerDependencies() {
        const missingList = [];
        for (const thisDependent of this._dependentList) {
            const packageFileContents = Utils.readPackageFileContents(thisDependent.packageRoot);
            for (const peerDependent in packageFileContents.peerDependencies) {
                // don't bother to a peerDependent twice.
                if (-1 !== missingList.indexOf(peerDependent))
                    continue;
                // we only report miss peerDependencies of our external modules.
                if (undefined === (this._externalModules.find((externalModule) => { return (externalModule.moduleName === peerDependent); })))
                    continue;
                if (undefined === this._dependentList.find((thisDependent) => { return (thisDependent.name === peerDependent); })) {
                    if (this._detail > 0)
                        console.log("  Dependent", thisDependent.name, "requires a peerDependency of", peerDependent, "but none found. Add ", peerDependent, "to dependencies in package.json");
                    missingList.push(peerDependent);
                }
            }
        }
        return missingList;
    }
    // finds the source module file. It is either relative to our localNodeModules, or relative to the dependent path where we found the package file.
    findExternalModuleFile(dependent, relativePath) {
        const localNodeModuleFile = path.resolve(this._nodeModulesDirectory, relativePath);
        if (fs.existsSync(localNodeModuleFile))
            return localNodeModuleFile;
        const dependentNodeModuleFile = path.resolve(dependent.parentPackageRoot, "node_modules", relativePath);
        if (fs.existsSync(dependentNodeModuleFile))
            return dependentNodeModuleFile;
        return undefined;
    }
    // finds dependents, symlinks them to destination directory.
    symlinkOrCopyExternalModules(outputDirectory) {
        if (this._detail > 0)
            console.log("Starting symlink or copy external modules");
        try {
            // create the output directory, if it doesn't exist.
            if (!fs.existsSync(outputDirectory)) {
                fs.mkdirSync(outputDirectory, { recursive: true });
            }
            // Read the package file for the current directory, and add the dependents recursively (to depth 2) to the sub-dependencies of the iModelJs modules.
            this.findExternalModuleDependents(process.cwd(), 0);
            const missingPeerDependencies = this.checkPeerDependencies();
            if (missingPeerDependencies.length > 0)
                return new Result("Symlink or Copy External Modules", 1, undefined, undefined, "You are missing one or more dependencies in package.json: \n".concat(...missingPeerDependencies));
            let missingModule = false;
            const missingModuleList = [];
            for (const dependent of this._dependentList) {
                const externalModule = dependent.externalModule;
                const versionString = dependent.versionAvailable;
                const moduleSourceFile = this.findExternalModuleFile(dependent, externalModule.relativePath);
                // report all the module files we can't find.
                if (!moduleSourceFile) {
                    missingModuleList.push(`Unable to locate required module file ${externalModule.moduleName} - looking for relative path ${externalModule.relativePath}\n`);
                    missingModule = true;
                }
                else {
                    let outFilePath = outputDirectory;
                    if (versionString) {
                        outFilePath = path.resolve(outputDirectory, "v" + versionString);
                        // create subdirectory if needed.
                        if (!fs.existsSync(outFilePath)) {
                            fs.mkdirSync(outFilePath, { recursive: true });
                        }
                    }
                    const fullFilePath = path.resolve(outFilePath, externalModule.destFileName);
                    this.symlinkOrCopyModuleFile(moduleSourceFile, fullFilePath);
                    // copy/symlink the iModelJsLoader.js file into the same directory as imodeljs-frontend
                    if (dependent.name === "imodeljs-frontend") {
                        const imjsLoaderSourceFile = moduleSourceFile.replace("imodeljs-frontend", "IModelJsLoader");
                        const imjsLoaderPath = path.resolve(outFilePath, "IModelJsLoader.js");
                        this.symlinkOrCopyModuleFile(imjsLoaderSourceFile, imjsLoaderPath);
                    }
                    // symlink any subModules in the build.
                    const packageFileContents = Utils.readPackageFileContents(dependent.packageRoot);
                    if (packageFileContents.iModelJs && packageFileContents.iModelJs.buildModule && packageFileContents.iModelJs.buildModule.subModules && Array.isArray(packageFileContents.iModelJs.buildModule.subModules)) {
                        for (const subModule of packageFileContents.iModelJs.buildModule.subModules) {
                            if (subModule.bundleName) {
                                const parsedPath = path.parse(moduleSourceFile);
                                const thisDirectory = parsedPath.dir;
                                const subModuleFileName = subModule.bundleName + ".js";
                                const subModuleSourceFile = path.resolve(thisDirectory, subModuleFileName);
                                const destFullFilePath = path.resolve(outFilePath, subModuleFileName);
                                this.symlinkOrCopyModuleFile(subModuleSourceFile, destFullFilePath);
                            }
                        }
                    }
                    // symlink the external modules resource files if necessary.
                    if (externalModule.publicResourceDirectory) {
                        const publicPath = path.resolve(dependent.packageRoot, externalModule.publicResourceDirectory);
                        this.symlinkOrCopyPublicStaticFiles(publicPath, outputDirectory);
                    }
                }
            }
            if (missingModule) {
                return new Result("Symlink or Copy External Modules", 1, undefined, undefined, "Could not find one or more dependencies:\n".concat(...missingModuleList));
            }
        }
        catch (e) {
            return new Result("Symlink or Copy External Modules", 1, e);
        }
        return new Result("Symlink or Copy External Modules", 0);
    }
}
// this class creates pseudo-localized versions of all the locale .json files specified in the sourceDirectory.
class PseudoLocalizer {
    constructor(_sourceDirectory, _destDirectory, _detail) {
        this._sourceDirectory = _sourceDirectory;
        this._destDirectory = _destDirectory;
        this._detail = _detail;
    }
    // pseudoLocalizes a string
    convertString(inputString) {
        let inReplace = 0;
        let outString = "";
        let replaceIndex = 0; // Note: the pseudoLocalize algorithm in Bim02 uses random, but here we cycle through because Javascript doesn't allow setting of the seed for Math.random.
        for (let iChar = 0; iChar < inputString.length; iChar++) {
            let thisChar = inputString.charAt(iChar);
            let nextChar = ((iChar + 1) < inputString.length) ? inputString.charAt(iChar + 1) : 0;
            // handle the {{ and }} delimiters for placeholders - don't want to do anything to characters in between.
            if (('{' === thisChar) && ('{' === nextChar)) {
                inReplace++;
                iChar++;
                outString = outString.concat("{{");
            }
            else if (('}' === thisChar) && ('}' === nextChar) && (inReplace > 0)) {
                inReplace--;
                iChar++;
                outString = outString.concat("}}");
            }
            else {
                let replacementChar = thisChar;
                if (0 === inReplace) {
                    let replacementsForChar = PseudoLocalizer.replacements[thisChar];
                    if (undefined !== replacementsForChar) {
                        replacementChar = replacementsForChar.charAt(replaceIndex++ % replacementsForChar.length);
                    }
                }
                outString = outString.concat(replacementChar);
            }
        }
        return outString;
    }
    // converts the JSON object
    convertObject(objIn) {
        const objOut = {};
        for (const prop in objIn) {
            if (objIn.hasOwnProperty(prop)) {
                if (typeof objIn[prop] === "string") {
                    objOut[prop] = this.convertString(objIn[prop]);
                }
                else if (typeof objIn[prop] === "object") {
                    objOut[prop] = this.convertObject(objIn[prop]);
                }
            }
        }
        return objOut;
    }
    // converts each JSON file.
    convertFile(inputFilePath, outputFile) {
        // read the file
        let jsonIn = fs.readFileSync(inputFilePath, { encoding: "utf8" });
        let objIn = JSON.parse(jsonIn);
        let objOut = this.convertObject(objIn);
        fs.writeFileSync(outputFile, JSON.stringify(objOut, null, 2));
        return 0;
    }
    convertAll() {
        try {
            Utils.makeDirectoryNoError(this._destDirectory);
            const sourceSpecification = path.join(this._sourceDirectory, "**/*.json");
            const found = glob.sync(sourceSpecification, { nodir: true });
            for (const fileName of found) {
                // find it relative to source.
                const relativePath = path.relative(this._sourceDirectory, fileName);
                const outputPath = path.resolve(this._destDirectory, relativePath);
                if (fs.existsSync(outputPath)) {
                    if (this._detail > 3)
                        console.log("  File", outputPath, "already exists");
                }
                else {
                    if (this._detail > 3)
                        console.log("  PseudoLocalizing", fileName, "to", outputPath);
                    Utils.makeDirectoryNoError(path.dirname(outputPath));
                    this.convertFile(fileName, outputPath);
                }
            }
        }
        catch (error) {
            return new Result("PseudoLocalize", 1, error);
        }
        return new Result("PseudoLocalize", 0);
    }
}
PseudoLocalizer.replacements = {
    A: "\u00C0\u00C1,\u00C2\u00C3,\u00C4\u00C5",
    a: "\u00E0\u00E1\u00E2\u00E3\u00E4\u00E5",
    B: "\u00DF",
    c: "\u00A2\u00E7",
    C: "\u00C7\u0028",
    D: "\u00D0",
    E: "\u00C8\u00C9\u00CA\u00CB",
    e: "\u00E8\u00E9\u00EA\u00EB",
    I: "\u00CC\u00CD\u00CE\u00CF",
    i: "\u00EC\u00ED\u00EE\u00EF",
    L: "\u00A3",
    N: "\u00D1",
    n: "\u00F1",
    O: "\u00D2\u00D3\u00D4\u00D5\u00D6",
    o: "\u00F2\u00F3\u00F4\u00F5\u00F6\u00F8",
    S: "\u0024\u00A7",
    U: "\u00D9\u00DA\u00DB\u00DC",
    u: "\u00B5\u00F9\u00FA\u00FB\u00FC",
    x: "\u00D7",
    Y: "\u00DD\u00A5",
    y: "\u00FD\u00FF",
};
// Class that holds the results of a build operation.
class Result {
    constructor(operation, exitCode, error, stdout, stderr) {
        this.operation = operation;
        this.exitCode = exitCode;
        this.error = error;
        this.stdout = stdout;
        this.stderr = stderr;
    }
}
// Class that contains a method for each step in building an iModelJs module.
class IModelJsModuleBuilder {
    // constructor
    constructor(_moduleDescription, _version, _detail, _isDevelopment, _webpackStats) {
        this._moduleDescription = _moduleDescription;
        this._version = _version;
        this._detail = _detail;
        this._isDevelopment = _isDevelopment;
        this._webpackStats = _webpackStats;
        this._alwaysCopy = process.env.BUILDIMODEL_SYMLINKS === undefined;
    }
    // checks the iModelJs buildModule property.
    checkDefinition() {
        // check the type.
        if (!this._moduleDescription.type) {
            console.log('iModelJs.buildModule.type must have a type property with value of "system", "application", "plugin", or "webworker"');
            return true;
        }
        if ((this._moduleDescription.type !== "system") && (this._moduleDescription.type !== "application") &&
            (this._moduleDescription.type !== "plugin") && (this._moduleDescription.type != "webworker")) {
            console.log('iModelJs.buildModule.type must be one of "system", "application", "plugin", or "webworker"');
            return true;
        }
        return false;
    }
    // compiles the tsc source according to tsconfig.js. (generally, compiles src/**/*.ts to lib)
    compileSource() {
        // The version of typescript required must be specified in package.json devDependencies.
        // In rush monorepos, it can be specified in the rush common/config/rush/common-version.json file.
        // npm (or rush) install mechanism puts tsc into the node_modules/.bin directory where npm will find it.
        // Note: I tried setting shell: true in the options (third) argument to execFile, and then just specifying
        // "tsc" (rather than tsc or tsc.cmd based on platform). Unfortunately, that wasn't reliable.
        return new Promise((resolve, _reject) => {
            if (this._detail > 0)
                console.log("Starting tsc compilation");
            const tscCommand = process.platform === "win32" ? "tsc.cmd" : "tsc";
            const tscFullPath = path.resolve(process.cwd(), "node_modules", ".bin", tscCommand);
            const args = [];
            if (this._moduleDescription.tscOptions) {
                const tscArgs = this._moduleDescription.tscOptions.split(" ");
                for (const tscArg of tscArgs)
                    args.push(tscArg);
            }
            args.push("1>&2");
            child_process.execFile(tscFullPath, args, { cwd: process.cwd(), shell: true }, (error, stdout, stderr) => {
                if (this._detail > 0)
                    console.log("Finished compilation");
                resolve(new Result("Compile .tsc files", (null !== error) || (stderr && stderr.length) ? 1 : 0, error, stdout, stderr));
            });
        });
    }
    // symlinks the web resources (like .scss and .svg files) into the lib directory for webpack to use later.
    async symlinkSourceResources() {
        // are there any files to symlink?
        if (!this._moduleDescription.sourceResources) {
            if (this._detail > 2)
                console.log("Skipping Symlink Source Resource, no iModelJs.buildModule.sourceResources property");
            return Promise.resolve(new Result("Symlink Or Copy Source Resources", 0));
        }
        // otherwise this should be an array of {source, dest} objects.
        if (!Array.isArray(this._moduleDescription.sourceResources))
            return Promise.resolve(new Result("Symlink Or Copy Source Resources", 1, undefined, undefined, "iModelJs.buildModule.sourceResources must be an array of {source, dest} pairs"));
        for (const resource of this._moduleDescription.sourceResources) {
            if (!resource.source || !resource.dest) {
                return Promise.resolve(new Result("Symlink Or Copy Source Resources", 1, undefined, undefined, "iModelJs.buildModule.sourceResources must be an array of {source, dest} pairs"));
            }
            if (this._detail > 0)
                console.log(this._alwaysCopy ? "Copying files from" : "Symlinking files from", resource.source, "to", resource.dest);
            const alwaysCopy = this._alwaysCopy || (resource.copy && resource.copy === true);
            const result = Utils.symlinkFiles(process.cwd(), resource.source, resource.dest, alwaysCopy, this._detail);
            if (0 != result.exitCode)
                return result;
        }
        return Promise.resolve(new Result("Symlink or Copy Source Resources", 0));
    }
    // If this is an application, symlink the external modules that the application uses into the web server's directory.
    symlinkRequiredExternalModules() {
        const nodeModulesDir = path.resolve(process.cwd(), "node_modules");
        const moduleCopier = new ModuleCopier(nodeModulesDir, this._isDevelopment, this._detail, this._alwaysCopy);
        if (this._moduleDescription.type !== "application")
            return Promise.resolve(new Result("Symlink or Copy External Modules", 0));
        if (!this._moduleDescription.webpack || !this._moduleDescription.webpack.dest)
            return Promise.resolve(new Result("Symlink Or Copy External Modules", 0));
        const outputDirectory = path.resolve(process.cwd(), this._moduleDescription.webpack.dest);
        return Promise.resolve(moduleCopier.symlinkOrCopyExternalModules(outputDirectory));
    }
    makeConfig() {
        let useCreateConfig = false;
        if (!this._moduleDescription.makeConfig)
            return Promise.resolve(new Result("makeConfig", 0));
        if (!this._moduleDescription.makeConfig.dest)
            return Promise.resolve(new Result("makeConfig", 1, undefined, undefined, 'The iModelJs.buildModule.makeConfig must have a "dest" property'));
        if (this._moduleDescription.makeConfig.sources) {
            useCreateConfig = true;
            if (!Array.isArray(this._moduleDescription.makeConfig.sources)) {
                return Promise.resolve(new Result("makeConfig", 1, undefined, undefined, 'iModelJs.buildModule.makeConfig.sources must be an array of {file, filter} pairs'));
            }
            for (const thisSource of this._moduleDescription.makeConfig.sources) {
                if (!thisSource.file || (undefined === thisSource.filter))
                    return Promise.resolve(new Result("makeConfig", 1, undefined, undefined, 'iModelJs.buildModule.makeConfig.sources must be an array of {file, filter} pairs'));
            }
        }
        const scriptName = useCreateConfig ? "createConfigFile.js" : "write.js";
        try {
            // get the path to config-loader/scripts/write.js module
            let makeConfigFullPath;
            const nestedConfigLoaderPath = `node_modules/@bentley/webpack-tools/node_modules/@bentley/config-loader/scripts/${scriptName}`;
            if (fs.existsSync(nestedConfigLoaderPath)) {
                // use the nested config-loader dependency
                makeConfigFullPath = path.resolve(process.cwd(), nestedConfigLoaderPath);
            }
            else {
                // attempt to use the sibling config-loader dependency. Would need to be explicitly declared as a dependency in a consumer's package.json
                const siblingConfigLoaderPath = `node_modules/@bentley/config-loader/scripts/${scriptName}`;
                makeConfigFullPath = path.resolve(process.cwd(), siblingConfigLoaderPath);
            }
            // figure out the arguments.
            const args = [makeConfigFullPath, this._moduleDescription.makeConfig.dest];
            if (useCreateConfig) {
                for (const thisSource of this._moduleDescription.makeConfig.sources) {
                    let filter = thisSource.filter;
                    if (0 === filter.length)
                        args.push(`${thisSource.file}`);
                    else
                        args.push(`${thisSource.file}|${filter}`);
                }
            }
            else {
                if (this._moduleDescription.makeConfig.filter)
                    args.push(this._moduleDescription.makeConfig.filter);
            }
            if (this._detail > 0)
                console.log("Starting makeConfig with arguments", args);
            return new Promise((resolve, _reject) => {
                child_process.execFile("node", args, { cwd: process.cwd() }, (error, stdout, stderr) => {
                    if (this._detail > 0)
                        console.log("Finished makeConfig");
                    resolve(new Result("makeConfig", (null !== error) || (stderr && stderr.length) ? 1 : 0, error, stdout, stderr));
                });
            });
        }
        catch (e) {
            return new Promise((resolve, _reject) => {
                resolve(new Result("Make Config", 1, e));
            });
        }
    }
    // find webpack executable.
    findWebpack() {
        // first look in node_modules/webpack
        const webpackCommand = process.platform === "win32" ? "webpack.cmd" : "webpack";
        const inLocalNodeModules = path.resolve(process.cwd(), "node_modules/.bin", webpackCommand);
        if (fs.existsSync(inLocalNodeModules))
            return inLocalNodeModules;
        const inToolsWebpackNodeModules = path.resolve(process.cwd(), "node_modules/@bentley/webpack-tools/node_modules/.bin", webpackCommand);
        if (fs.existsSync(inToolsWebpackNodeModules))
            return inToolsWebpackNodeModules;
        return undefined;
    }
    // spawns a webpack process
    startWebpack(operation, outputPath, entry, bundleName, styleSheets, buildType, version, isDevelopment, doStats, moduleNum, htmlTemplate) {
        const webpackFullPath = this.findWebpack();
        if (!webpackFullPath) {
            return Promise.resolve(new Result(operation, 1, undefined, undefined, "Unable to locate webpack"));
        }
        const args = [];
        const configPath = path.resolve(process.cwd(), "node_modules/@bentley/webpack-tools/modules/webpackModule.config.js");
        args.push(`--config=${configPath}`);
        args.push(`--env.outdir=${outputPath}`);
        args.push(`--env.entry=${entry}`);
        args.push(`--env.bundlename=${bundleName}`);
        if (styleSheets)
            args.push("--env.stylesheets");
        if (buildType === "plugin")
            args.push("--env.plugin");
        else if (buildType === "webworker")
            args.push("--env.webworker");
        if (!isDevelopment)
            args.push("--env.prod");
        if (htmlTemplate)
            args.push(`--env.htmltemplate=${htmlTemplate}`);
        if (doStats) {
            // make sure the output directory exists.
            if (!fs.existsSync(outputPath)) {
                fs.mkdirSync(outputPath, { recursive: true });
            }
            const outFileName = `webpackStats${moduleNum}.json`;
            const jsonFile = path.resolve(outputPath, outFileName);
            args.push("--json");
            args.push(">" + jsonFile);
        }
        return new Promise((resolve, _reject) => {
            child_process.execFile(webpackFullPath, args, { cwd: process.cwd() }, (error, stdout, stderr) => {
                if (this._detail > 0)
                    console.log("Finished", operation);
                // if we are building an application, move the main.js to the version directory.
                if (buildType === "application" && version) {
                    const destPath = path.resolve(outputPath, "v" + version);
                    Utils.makeDirectoryNoError(destPath);
                    Utils.moveFile(outputPath, destPath, "main.js");
                    Utils.moveFile(outputPath, destPath, "main.js.map");
                    Utils.moveFile(outputPath, destPath, "runtime.js");
                    Utils.moveFile(outputPath, destPath, "runtime.js.map");
                }
                resolve(new Result(operation, (null !== error) || (stderr && stderr.length) ? 1 : 0, error, stdout, stderr));
            });
        });
    }
    // Webpack the module.
    webpackModule() {
        // if no webpack property, skip it.
        if (!this._moduleDescription.webpack) {
            if (this._detail > 2)
                console.log("Skipping Webpack, no iModelJs.buildModule.webpack property");
            return Promise.resolve(new Result("Webpack", 0));
        }
        // make sure the required keys are there.
        const webpack = this._moduleDescription.webpack;
        if (!webpack.dest || !webpack.entry || !webpack.bundleName) {
            return Promise.resolve(new Result("Webpack", 1, undefined, undefined, 'IModelJs.buildModule.webpack must have "dest", "entry", and "bundleName" properties'));
        }
        let outputPath = path.resolve(process.cwd(), webpack.dest);
        if (this._moduleDescription.type === "system") {
            outputPath = path.resolve(outputPath, this._isDevelopment ? "dev" : "prod");
        }
        // start the webpack process according to the arguments.
        const styleSheets = webpack.styleSheets ? true : false;
        if (this._detail > 0)
            console.log("Starting Webpack Module");
        return this.startWebpack("Webpack Module", outputPath, webpack.entry, webpack.bundleName, styleSheets, this._moduleDescription.type, this._version, this._isDevelopment, this._webpackStats, 0, webpack.htmlTemplate);
    }
    // build the array of subModules.
    async buildSubModules() {
        if (!this._moduleDescription.subModules) {
            if (this._detail > 2)
                console.log("Skipping Build SubModules - No iModelJs.buildModule.subModules property");
            return Promise.resolve([new Result("Build SubModules", 0)]);
        }
        if (!Array.isArray(this._moduleDescription.subModules)) {
            return Promise.resolve([new Result("Build SubModules", 1, undefined, undefined, "iModelJs.buildModule.subModules must be an array of {dest, entry, bundleName} objects")]);
        }
        const results = [];
        let moduleNum = 1;
        for (const subModule of this._moduleDescription.subModules) {
            if (!subModule.dest || !subModule.entry || !subModule.bundleName) {
                results.push(new Result("Build SubModules", 1, undefined, undefined, 'Each subModule must have a "dest", "entry", and "bundleName" property'));
                return Promise.resolve(results);
            }
            const styleSheets = subModule.styleSheets ? true : false;
            // this is a special case for the IModelJsLoader - set plugin.type to "system" or "webworker" to avoid plugin treatment.
            const subType = subModule.type || "plugin";
            if ((subType !== "system") && (subType !== "plugin") && (subType != "webworker")) {
                console.log('the "type" property for a subModule must be one of "system", "plugin", or "webworker"');
            }
            let outputPath = path.resolve(process.cwd(), subModule.dest);
            if ((subType === "system") || (subType === "webworker"))
                outputPath = path.resolve(outputPath, this._isDevelopment ? "dev" : "prod");
            if (this._detail > 0)
                console.log("Starting webpack of", subModule.entry);
            const pluginResult = await this.startWebpack(`Webpack Plugin ${subModule.entry}`, outputPath, subModule.entry, subModule.bundleName, styleSheets, subType, undefined, this._isDevelopment, this._webpackStats, moduleNum++);
            results.push(pluginResult);
            if (pluginResult.error || pluginResult.stderr) {
                return Promise.resolve(results);
            }
        }
        return Promise.resolve(results);
    }
    pseudoLocalize() {
        if (!this._moduleDescription.pseudoLocalize) {
            if (this._detail > 2)
                console.log("Skipping Symlink Source Resource, no iModelJs.buildModule.sourceResources property");
            return new Result("Pseudo localize", 0);
        }
        if (!this._moduleDescription.pseudoLocalize.source || !this._moduleDescription.pseudoLocalize.dest) {
            return new Result("Pseudo localize", 1, undefined, undefined, 'IModelJs.buildModule.pseudoLocalize must have "source" and "dest" properties');
        }
        const sourceDirectory = path.resolve(process.cwd(), this._moduleDescription.pseudoLocalize.source);
        const destDirectory = path.resolve(process.cwd(), this._moduleDescription.pseudoLocalize.dest);
        if (this._detail > 0)
            console.log("Starting pseudoLocalize");
        const pseudoLocalizer = new PseudoLocalizer(sourceDirectory, destDirectory, this._detail);
        if (this._detail > 0)
            console.log("Finished PseudoLocalize");
        return pseudoLocalizer.convertAll();
    }
    // If there's an error in the Result, report it and set the exitCode.
    reportError(result) {
        let exitCode = result.exitCode;
        if (result.error && !result.stderr) {
            console.error("\n-------- Operation:", result.operation, "--------");
            console.error(result.error.toString());
            console.error(result.error);
            if (result.stdout) {
                console.error("Output:");
                console.error(result.stdout);
            }
        }
        if (result.stderr) {
            console.error("\n-------- Operation:", result.operation, "--------");
            console.error("Errors:");
            console.error(result.stderr);
            if (result.stdout) {
                console.error("Output:");
                console.error(result.stdout);
            }
            exitCode = 1;
        }
        if (result.stdout && (this._detail > 1)) {
            console.log("\n-------- Operation:", result.operation, "--------");
            console.log("Output:");
            console.log(result.stdout);
        }
        return exitCode;
    }
    // report results for a list of steps.
    reportResults(results) {
        // check all results
        let exitCode = 0;
        for (const result of results) {
            const thisExitCode = this.reportError(result);
            if (0 !== thisExitCode)
                exitCode = thisExitCode;
        }
        return exitCode;
    }
    /* ----------------------
    // step one - parallel compile and symlink of source needed in webpack.
    // Not currently used. Ran into problem where the two process would collide
    // trying to create the output directories.
    private async _compileAndSymlinkSources(): Promise<Result[]> {
      // compile the .ts and .tsx files
      const compileResult = this.compileSource();
  
      // symlink the source resource ().scss and .svg files, public locale files, etc.) to the lib directory for inclusion in the webpack.
      const symlinkSourceResourcesResult = this.symlinkSourceResources();
  
      // wait for all of those operations to finish.
      return Promise.all([compileResult, symlinkSourceResourcesResult])
    }
    ------------------------ */
    // step two - parallel webpack and symlink of external modules needed for applications
    async webpackAndSymlinkExternalModules() {
        // webpack the module.
        const webpackResults = this.webpackModule();
        // If this is an application, symlink the required external modules to the webresources directory.
        const symlinkExternalModulesResult = this.symlinkRequiredExternalModules();
        // wait for the webpack and external modules operations to finish.
        return Promise.all([webpackResults, symlinkExternalModulesResult]);
    }
    // this is the method that sequences the build.
    async sequenceBuild() {
        const symlinkResults = await this.symlinkSourceResources();
        let exitCode = this.reportResults([symlinkResults]);
        if (0 !== exitCode)
            return exitCode;
        const compileResults = await this.compileSource();
        exitCode = this.reportResults([compileResults]);
        if (0 !== exitCode)
            return exitCode;
        const stepTwoResults = await this.webpackAndSymlinkExternalModules();
        exitCode = this.reportResults(stepTwoResults);
        if (0 !== exitCode)
            return exitCode;
        const pluginResults = await this.buildSubModules();
        exitCode = this.reportResults(pluginResults);
        if (0 !== exitCode)
            return exitCode;
        const makeConfigResult = await this.makeConfig();
        exitCode = this.reportResults([makeConfigResult]);
        if (0 != exitCode)
            return exitCode;
        const pseudoLocalizeResult = this.pseudoLocalize();
        exitCode = this.reportResults([pseudoLocalizeResult]);
        return exitCode;
    }
}
// build iModelJs module according to the specifications found in package.json's iModelJs.buildModule property.
// The package.iModelJs.buildModule property has these keys:
//  type - (required) string with value of "system", "application", or "plugin".
//  detail - (optional) number between 0 and 4. The greater of module.detail and args.detail is used.
//  sourceResources - (optional) object array with each object containing a "source" and "dest" key with the specifications of files to symlink from
//                    source to dest. Typically something like { "source": "./src/**/*.scss", "dest": ".lib"}; Usually used for application and plugin types.
//  tscOptions - (optional) options to pass to the tsc command line. Usually, the build just does "tsc" and uses tsconfig.json for all options.
//  webpack - (optional) object with properties:
//    "dest" - (required) output directory for webpacked bundle. Typically "lib/module" for modules and "lib/webresources" for applications and plugins.
//    "entry" - (required) entry script file point for webpack to start. Typicall "lib/index.js" or "lib/main.js".
//    "bundleName" - (required) the name of the bundle. For applications, "main.js". For modules, the name of the module. For plugins, the name of the plugin.
//    "styleSheets" - (optional) if present and true, indicates that webpack needs to use the stylesheet loading plugins. Slows webpack down considerably.
//    "htmlTemplate" - (optional) For applications only, uses the specified html file as a template to create the webpage's html file.
//
async function main() {
    const cmdLineArgs = getArgs();
    const packageContents = Utils.readPackageFileContents(process.cwd());
    // figure out the detail level.
    let detail = 0;
    if (cmdLineArgs.verbose)
        detail = 1;
    if (cmdLineArgs.detail)
        detail = (cmdLineArgs.detail === true) ? 1 : cmdLineArgs.detail;
    // package.json can increase detail level.
    if (packageContents.iModelJs && packageContents.iModelJs.buildModule.detail && (packageContents.iModelJs.buildModule.detail > detail))
        detail = packageContents.iModelJs.buildModule.detail;
    // report command line.
    if (detail > 0) {
        console.log("detail:", detail);
        console.log("production:", cmdLineArgs.production);
        console.log("stats:", cmdLineArgs.stats);
    }
    if (!packageContents.iModelJs || !packageContents.iModelJs.buildModule) {
        console.log("Building an iModel.js module requires an iModelJs.buildModule entry in package.json");
        return 1;
    }
    // instantiate the builder
    const isDevelopment = !cmdLineArgs.production;
    const doStats = cmdLineArgs.stats;
    const builder = new IModelJsModuleBuilder(packageContents.iModelJs.buildModule, packageContents.version, detail, isDevelopment, doStats);
    if (builder.checkDefinition())
        return 1;
    return await builder.sequenceBuild();
}
main().then((exitCode) => { process.exit(exitCode); });
//# sourceMappingURL=buildIModelJsModule.js.map