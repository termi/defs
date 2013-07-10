"use strict";
const fs = require("fs");
const fmt = require("simple-fmt");
const path = require("path");
const exec = require("child_process").exec;
const ansidiff = require("ansidiff");

const commandVariables = {};
process.argv.forEach(function(arg, index, array) {
	var nextArg;
	if( arg.indexOf("--") === 0 ) {
		if( nextArg = array[index + 1] ) {
			this[arg.substring(2)] = nextArg.indexOf("--") === 0 ? true : nextArg;
		}
	}
}, commandVariables);


function slurp(filename) {
    return fs.existsSync(filename) ? String(fs.readFileSync(filename)).trim() : "";
}

var tests;

if( commandVariables.file && typeof commandVariables.file === "string" ) {
	tests = [
		commandVariables.file
	]
}
else {
	tests = fs.readdirSync("tests").filter(function(filename) {
		return !/-out\.js$/.test(filename) && !/-stderr$/.test(filename);
	});
}

if( commandVariables.filter && typeof commandVariables.filter === "string" ) {
	commandVariables.filter = commandVariables.filter.toLowerCase();
	tests = tests.filter(function(filename) {
		return filename.toLowerCase().indexOf(commandVariables.filter) !== -1;
	})
}

function stringCompare(str1, str2, compareType, removeLines) {
	str1 = str1.replace(/\n\r/g, "\n").replace(/\r\n/g, "\n").replace(/\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
	str2 = str2.replace(/\n\r/g, "\n").replace(/\r\n/g, "\n").replace(/\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");

	const compareFunction = compareType === "lines" ? ansidiff.lines : ansidiff.chars;

	let equal = true
		, lastDiffIndex = null
		, result = compareFunction.call(ansidiff, str1, str2, function(obj, i, array) {
			if( obj.added || obj.removed ) {
				lastDiffIndex = i;
				equal = false;

				/*obj.added && console.log("added", "'" + obj.value + "'")
				obj.removed && console.log("removed", "'" + obj.value + "'")*/

				if(!obj.value.trim())obj.value = "'" + obj.value + "'"
			}
			else if(removeLines) {
				return null;
			}

			return ansidiff.bright(obj);
		})
	;

    return equal === true || result;
}

function run() {
	var test;

    if(!(test = tests.pop()))return;



    const noSuffix = test.slice(0, -3);
    exec(fmt("node --harmony defs-wrapper tests/{0}", test), function(error, stdout, stderr) {

        stderr = (stderr || "").trim();
        stdout = (stdout || "").trim();
        const expectedStderr = slurp(fmt("tests/{0}-stderr", noSuffix));
        const expectedStdout = slurp(fmt("tests/{0}-out.js", noSuffix));

		const compare1 = stringCompare(expectedStderr, stderr, "lines");
		const compare2 = stringCompare(expectedStdout, stdout, "lines", true);

        if (compare1 !== true) {
            fail("stderr", compare1);
			//console.log(stderr);//, "+|+", stdout, "|error|", error);
        }
        if (compare2 !== true) {
            fail("stdout", compare2);
			//console.log(stdout);//, "+|+", stderr, "|error|", error);
        }

		function fail(type, diff) {
			console.log(fmt("FAILED test {0} TYPE {1}", test, type));
			console.log(diff);
			console.log("\n---------------------------\n");
		}
        
        run();//next test
    });
}

run();//next test
