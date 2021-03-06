# url-monitor

Monitor urls using headless chromium and compare the result using GraphicsMagick.
Output is using Nagios format.

### Installation

Install GraphicsMagick:
http://www.graphicsmagick.org/download.html

Install nodejs dependencies:
```sh
$ npm install
```

### Run
```sh
$ node app.js 
```
# Running options
```sh node app.js
    --config="./config.js" # run with different config file
    --ref # force to create new reference images
```

### Configuration (config.js)
```js
// ============
// config.js
// ============
module.exports = {
    browser: {
        // Maximum number of browser tabs
        threads: 5,
        // If you want to capture the whole page not just the viewport
        fullPageCapture: true,
        // Size of the browser window
        viewport: {
            width: 1366,
            height: 768
        },
    },
    // nagios thresholds based on image compare result
    criticalThreshold: 0.002,
    warningThreshold: 0.001,
    // Path to save all the images
    historyPath: "./history",
    // URLs to process
    urls: [
        "file:///D:/5/1.html",
        "file:///D:/5/2.html",
        "file:///D:/5/3.html",
    ],
};

```