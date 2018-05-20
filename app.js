const puppeteer = require('puppeteer');
const argv = require('minimist')(process.argv.slice(2));
const gm = require('gm');
const low = require('lowdb');
const fs = require('fs');
const NagiosPlugin = require('nagios-plugin');
const FileSync = require('lowdb/adapters/FileSync');
const adapter = new FileSync('db.json');
const db = low(adapter);
const PromisePool = require('promise-pool-executor');
const moment = require('moment');



const configFile = (argv.config) ? argv.config : './config.js';
if (!fs.existsSync(configFile)) {
	console.error("Config file not found: " + argv.config);
	process.exit(1);
}
const config = require(configFile);

// Set some defaults (required if your JSON file is empty)
db.defaults({ reference: {}, history: [] }).write();

const nagios = new NagiosPlugin({
    shortName: 'url_monitor',
});

nagios.setThresholds({
    'critical': "0:" + config.criticalThreshold,
    'warning': "0:" + config.warningThreshold,
});
// Create new references images/htmls
const forceReference = (argv.ref) ? true : false;

const now = moment();
const fullDate = {
    date: now.format("YYYY-MM-DD"),
    time: now.format("HH:mm:ss"),
    fileTime: now.format("HH[h]mm[m]ss[s]"),
};

function compareImage(image1Path, image2Path, imageDiffPath) {
    return new Promise((resolve, reject) => {
        var options = {
            highlightStyle: 'Assign',
            highlightColor: '#ff00ff',
            tolerance: 0,
            file: imageDiffPath,
        };
        gm.compare(image1Path, image2Path, options, (error, isEqual, difference, raw) => {
            if (error) reject("Failed to diff files", error);
            resolve(difference);
        });
    });
}

function urlToFilename(url) {
    return url.replace("://", "_")
        .replace('/', '-')
        .replace(/[^0-9a-zA-Z_\.\-]/g, "");
}

function saveHtml(path, htmlText) {
    return new Promise((resolve, reject) => {
        fs.writeFile(path, htmlText, (error) => {
            if (error) {
                reject("Failed to save HTML file: " + error);
            } else {
                resolve();
            }
        });
    });
}

function getNagiosStatus(url, diff) {
    if (diff === null || diff < config.warningThreshold) {
        return {
            status: nagios.states.OK,
            message: "Nothing changed at: " + url,
        };
    } else if (diff <= config.criticalThreshold) {
        return {
            status: nagios.states.WARNING,
            message: "Noticeable change at: " + url,
        };
    } else {
        return {
            status: nagios.states.CRITICAL,
            message: "Major change at: " + url,
        };
    }
}

function makeDirsSync(urlList) {
    // Parent dir: ./history
    if (!fs.existsSync(config.historyPath)) {
        fs.mkdirSync(config.historyPath);
    }
    // Reference dir: ./history/refs
    if (!fs.existsSync(config.historyPath + "/refs")) {
        fs.mkdirSync(config.historyPath + "/refs");
    }
    // Parent dir: ./history/<date>
    const datePath = config.historyPath + '/' + fullDate.date;
    if (!fs.existsSync(datePath)) {
        fs.mkdirSync(datePath);
    }
    // URL dir: ./history/<date>/<url>
    for (let i = 0; i < urlList.length; i++) {
        const urlPath = config.historyPath + '/' + fullDate.date + '/' + urlToFilename(urlList[i]);
        if (!fs.existsSync(urlPath)) {
            fs.mkdirSync(urlPath);
        }
    }
}

function deleteFiles(pathList) {
    for (let i=0; i<pathList.length; i++) {
        if (pathList[i] && fs.existsSync(pathList[i])){
            fs.unlinkSync(pathList[i]);
        }
    }
}

function maintainOldFiles() {
    let historyList = db.get("history").value();
    
    if (historyList.length < 1) {
        return;
    }
    
    for (let i=historyList.length-1; i>=0; i--) {
        if (moment(historyList[i].date).add(config.imageLogTimeout, 'days').isBefore(moment(now.format("YYYY-MM-DD")))) {
            deleteFiles([
                historyList[i].imagePath,
                historyList[i].htmlPath,
                historyList[i].imageDiffPath,
            ]);			
            // remove ./history/<date>/<url> folder
            if (i === 0) {
                deleteFiles([config.historyPath + '/' + historyList[i].date + '/' + urlToFilename(historyList[i].url)]);
            }
            db.get("history").pop().write();
        } else {
            // it's ordered by date
            return;
        }
    }
}

async function handleUrl(browser, url) {
    return new Promise(async (resolve, reject) => {
        try {
            const page = await browser.newPage();
            await page.setViewport({
                width: config.browser.viewport.width,
                height: config.browser.viewport.height
            })
            const response = await page.goto(url);
            const htmlText = await response.text();
			
            const referenceImage = db.get("reference").value()[url];
			let basePath;
			let deepPath;
			if (forceReference || !referenceImage) {
				basePath = config.historyPath + "/refs/" + urlToFilename(url);				
				deepPath = basePath + "_" + fullDate.date + "_" + fullDate.fileTime;
			} else {
				basePath = config.historyPath + '/' + fullDate.date + '/' + urlToFilename(url);
				deepPath = basePath + '/' + fullDate.fileTime;				
			}

            const historyData = {
                date: fullDate.date,
                time: fullDate.time,
                url: url,
                imagePath: deepPath + '.png',
                imageDiffPath: deepPath + '_DIFF.png',
                imageDiff: 0,
                htmlPath: deepPath + '.html',
                htmlDiff: 0,
            }

            await saveHtml(historyData.htmlPath, htmlText);

            await page.screenshot({
                path: historyData.imagePath,
                fullPage: config.browser.fullPageCapture
            });

            // Diff with the latest screenshot
			if(forceReference || !referenceImage) {
                historyData.imageDiffPath = null;
                historyData.imageDiff = 0;
            } else {
                historyData.imageDiff = await compareImage(referenceImage.imagePath, historyData.imagePath, historyData.imageDiffPath);
            }

            // cleanup if status is OK
            const nagiosStatus = getNagiosStatus(historyData.url, historyData.imageDiff);
			if (forceReference || !referenceImage) {
                // Reference image only
                let ref = db.get("reference").value();
                if (ref[url]) {
                    deleteFiles([
                        ref[url].imagePath,
                        ref[url].htmlPath,
                    ]);
                }
                ref[url] = historyData;
                db.set("reference", ref).write();
            } else {
                // Normal
                if (nagiosStatus.status === nagios.states.OK) {
                    deleteFiles([
                        historyData.imagePath,
                        historyData.imageDiffPath,
                        historyData.htmlPath,
                    ]);
                } else {
                    db.get("history").unshift(historyData).write();
                }
            }

            await page.close();
            resolve({ status: nagiosStatus.status, message: nagiosStatus.message })
        } catch (e) {
            resolve({ status: nagios.states.WARNING, message: e })
        }
    });
}


(async () => {
    maintainOldFiles();

    const browser = await puppeteer.launch();

    const urlList = config.urls;
    makeDirsSync(urlList);

    const pool = new PromisePool.PromisePoolExecutor({
        concurrencyLimit: config.browser.threads
    });
    const results = await pool.addEachTask({
        data: urlList,
        generator: (url) => { return handleUrl(browser, url); }
    }).promise();

    for (let i = 0; i < results.length; i++) {
        nagios.addMessage(results[i].status, results[i].message);
    }

    await browser.close();

    const messageObj = nagios.checkMessages();
    nagios.nagiosExit(messageObj.state, messageObj.message);
})();
