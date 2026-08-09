const { app } = require('electron')

const STARTUP_PROBE_SWITCH = '--highlighter-packaged-startup-probe'

if (process.argv.includes(STARTUP_PROBE_SWITCH)) {
  app.whenReady()
    .then(() => app.quit())
    .catch((error) => {
      console.error(error.message || String(error))
      app.exit(1)
    })
} else {
  require('../main.js')
}
