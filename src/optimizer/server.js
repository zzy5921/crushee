const fs = require("fs")
const os = require("os")
const path = require("path")
const { fork } = require('child_process');
const del = require('del')
const uuidv1 = require('uuid/v1')
const EventEmitter = require('events');
const appDataPath = require('appdata-path')
const slash = require('slash')


let Settings = {}
const sendMessage = (type, payload = {}) => {
    process.send({
        type,
        payload
    })
}

class File {
    constructor(filePath) {
        const base = path.basename(filePath)
        const ext = path.extname(filePath)

        this.UUID = getUUID()
        this.Status = "pending"
        this.LastEvent = Date.now()
        this.Path = slash(outPath + this.UUID + "/")
        this.In = {
            Source: filePath,
            FileName: base.substr(0, base.length - ext.length),
            Extension: ext,
            Format: "",
            FileSize: 0,
            X: 0,
            Y: 0
        }
        this.Out = {
            Crushed: false,
            Extension: false,
            FileSize: 0,
            X: 0,
            Y: 0
        }
        uploads[this.UUID] = this
        return this;
    }
    setStatus(status) {
        this.Status = status;
        this.LastEvent = Date.now()
    }
}

const outPath = slash(path.normalize(path.join(appDataPath("crushee-desktop"), "public/out/")))

let jobQueue = []
let uploads = []

// Limit extra threads
let maxProcessingThreads = (os.cpus().length > 3 ? Math.floor(os.cpus().length / 3) + 1 : 1)
let fileProcessorThreads = []

/*
//
//
//   STARTUP
//
//
*/

// Clear output folder at startup
function cleanUp() {
    console.log("Cleaning old output files")

    try {
        del.sync([slash(outPath)], { force: true })
    } catch (e) {
        console.log(e)
    }

    try {
        if (!fs.existsSync(slash(outPath))) {
            fs.mkdirSync(slash(outPath), { recursive: true })
        }
    } catch (e) {
        console.log(e)
    }

    console.log("Done cleaning!")

}
cleanUp()

// Set up processing threads
for (let i = 0; i < maxProcessingThreads; i++) {
    const forked = makeThread(i)
    fileProcessorThreads.push(forked)
}

function makeThread(threadNum) {
    let thread = fork('./src/optimizer/file-thread.js', [], { silent: false })

    const forked = {
        queue: 0,
        threadNum,
        thread,
        jobs: [],
        lastAlive: Date.now()
    }
    forked.thread.send({
        type: 'setThreadNum',
        result: threadNum
    })

    // Handle messages and queue updates
    forked.thread.on('message', (data) => {
        if (data.type === "queueLength") {
            fileProcessorThreads[data.threadNum].queue = data.result
        } else if (data.type === "generic") {
            console.log(`\x1b[35mThread ${data.threadNum} says\x1b[0m "${(typeof data.message === 'object' ? JSON.stringify(data.message) : data.message)}"`)
        } else if (data.type === "alive") {
            forked.lastAlive = Date.now()
        } else if (data.type === "jobRequest") {

            if (jobQueue.length > 0) {
                // Get job from queue
                let job = jobQueue.splice(0, 1)[0]
                forked.jobs[job.uuid] = job

                // Send job to thread
                forked.thread.send({
                    type: 'job',
                    uuid: job.uuid,
                    payload: job.payload
                }, (e) => {
                    if (e) {
                        // If errored out, put back in to queue
                        console.log(e)
                        delete forked.jobs[job.uuid]
                        jobQueue.push(job)
                    }
                })
            }

        } else if (data.type === "finished") {
            // Return response from server
            forked.jobs[data.uuid].callback(data.result)
            delete forked.jobs[data.uuid];
        }

    })

    return forked
}


// Monitor and restart unresponsive threads
setInterval(monitorThreads, 3000)
function monitorThreads() {
    fileProcessorThreads.forEach((fork, idx) => {
        const now = Date.now()
        //console.log(`Thread ${idx} last alive ${(now - fork.lastAlive) / 1000}s ago`)
        if (fork.lastAlive < now - (1000 * 10)) {
            console.log(`Thread ${idx} responsive. Restarting thread.`)
            fork.thread.kill()
            fileProcessorThreads[idx] = makeThread(idx)
        }
    })
}


// Print queues to console
printQueues = () => {
    let outStrs = []
    for (let i = 0; i < fileProcessorThreads.length; i++) {
        outStrs.push(`${fileProcessorThreads[i].queue}`)
    }
    process.stdout.clearLine();
    process.stdout.cursorTo(0);
    process.stdout.write(`[${Date.now()}] Thread queues: ` + outStrs.join(" | ") + "\r")
}
//setInterval(printQueues, 1000)




/*
//
//
//   FUNCTIONS
//
//
*/


// Reviews file, generates previews
async function analyzeFile(uuid, uploadName, inFile, outDir) {
    // Wait for response from thread
    return new Promise((resolve, reject) => {

        jobQueue.push({
            uuid,
            payload: [uuid, uploadName, inFile, outDir, {}, "preview"],
            callback: resolve
        })

    }).then((result) => {
        if (result) {
            // We did it!
            uploads[uuid].Status = "analyzed"
            uploads[uuid].In = Object.assign(uploads[uuid].In, result)
            fileUpdateEvent(uuid)
            return result
        } else {
            uploads[uuid].Status = "error"
            fileUpdateEvent(uuid)
        }

    }).catch((e) => {
        // Something bad went wrong with the job
        console.log(e)
        uploads[uuid].Status = "error"
        fileUpdateEvent(uuid)
        throw e
    })
}



async function processFile(uuid, uploadName, inFile, outDir, options = {}) {
    uploads[uuid].Status = "crushing"
    fileUpdateEvent(uuid)

    // Wait for response from thread
    return new Promise((resolve, reject) => {

        jobQueue.push({
            uuid,
            payload: [uuid, uploadName, inFile, outDir, options],
            callback: resolve
        })

    }).then((result) => {
        // We did it!
        uploads[uuid] = Object.assign(uploads[uuid], result)
        uploads[uuid].Status = "done"
        uploads[uuid].Out = Object.assign(uploads[uuid].Out, result)
        fileUpdateEvent(uuid)
        return result
    }).catch((e) => {
        // Something bad went wrong with the job
        console.log(e)
        uploads[uuid].Status = "error"
        fileUpdateEvent(uuid)
        throw e
    })

}

getUUID = () => {
    // Make UUID
    let uuid = uuidv1();
    let uuidDir = outPath + uuid + "/"

    // Check if folder UUID exists, reroll
    while (fs.existsSync(uuidDir)) {
        consoleLog("UUID exists, rerolling")
        uuid = uuidv1();
        uuidDir = outPath + uuid + "/"
    }
    fs.mkdirSync(uuidDir)
    return uuid
}





const fileStatus = new EventEmitter()
const fileUpdateEvent = (uuid) => {
    let file = Object.assign({}, uploads[uuid])
    // Remove sever-only data... once I add some?
    fileStatus.emit("update", file)
}




const scanFiles = (inFiles) => {

    const files = (typeof inFiles == "object" ? inFiles : [inFiles])

    // Loop through files async, find files, scan dirs
    for (let i = 0, file; file = files[i]; i++) {
        fs.stat(file, (err, stats) => {
            if (stats && stats.isFile()) {

                // If setting enabled, skip invalid extensions
                let skipFile = false
                if (Settings.FilterUsingExtension) {
                    const ext = path.extname(file).toLowerCase()
                    if (ext !== ".jpg" && ext !== ".jpeg" && ext !== ".png" && ext !== ".svg" && ext !== ".webp" && ext !== ".gif") {
                        console.log("Invalid extension. Skipping " + file)
                        skipFile = true
                    }
                }

                // Is file: upload
                if (!skipFile) {
                    uploadFile(file)
                }
            } else if (stats.isDirectory()) {
                // Is directory: scan directory
                fs.readdir(file, (err, dirFiles) => {
                    let fileList = []
                    for (let dirFile of dirFiles) {
                        fileList.push(slash(file + "/" + dirFile))
                    }
                    scanFiles(fileList)
                });
            }
        })
    }
}


const uploadFile = (pathName) => {
    
    console.log(`\x1b[34mAnalyzing\x1b[0m ${pathName}`)

    const file = new File(pathName)
    file.setStatus("processing")
    const uuidDir = file.Path

    sendMessage("upload", {
        id: file.UUID,
        file
    })

    const filePath = slash(path.join(uuidDir, "source" + path.extname(pathName)))
    fs.writeFileSync(slash(path.join(uuidDir, "filename")), path.basename(pathName))
    fs.copyFileSync(slash(pathName), filePath)

    // Send off to a thread
    analyzeFile(file.UUID, path.basename(pathName), filePath, outPath)

}

fileStatus.on("update", (file) => {
    sendMessage("update", {
        uuid: file.uuid,
        file
    })
})

fileStatus.on("replaceUUID", (oldUUID, file) => {
    sendMessage("replace", {
        oldUUID,
        file
    })
})



process.on('message', function (msg) {
    data = JSON.parse(msg)
    let uuids
    if (typeof data.type != undefined)
        switch (data.type) {
            case "quit":
                for (let thread of fileProcessorThreads) {
                    thread.thread.send({ type: 'quit' })
                }
                cleanUp()
                console.log("Optimizer shutting down...")
                process.exit(0)
                break;
            case "all-files":
                sendMessage("all-files", getAllFiles())
                break;
            case "clear":
                removeFiles(data.payload)
                break;
            case "upload":
                //uploadFile(data.payload.path, JSON.parse(data.payload.settings), data.payload.id)
                scanFiles(data.payload.path)
                break;
            case "crush":
                crush(data.payload.UUID, data.payload.options)
                break;
            case "check":
                uuids = checkUUIDs(data.payload)
                sendMessage("check", uuids)
                break;
            case "settings":
                Settings = data.payload.settings;
                break;
            case "recrush":
                uuids = data.payload.uuids
                if (typeof uuids == "object") {
                    uuids.forEach((uuid) => recrush(uuid, data.payload.options))
                } else {
                    recrush(uuids, data.payload.options)
                }
                break;
        }
});


const getAllFiles = () => {
    files = []
    console.log(uploads)
    for (let uuid in uploads) {
        if (uploads[uuid].status != "error") {
            files.push(uploads[uuid])
        }
    }
    return files
}

const removeFiles = (uuids) => {

    if (typeof uuids === "string") {
        // Only one UUID provided. Deleting files and metadata.
        removeUUID(uuids)
        return true
    } else if (typeof uuids === "object") {
        // Multiple UUIDs provided. Deleting files and metadata.
        uuids.forEach((uuid) => {
            removeUUID(uuid)
        })
        return true
    }
    // WTF did you send?
    return false
}

const removeUUID = (uuid) => {
    try {
        let cleanedUUID = uuid.replace(".", "")
        uploads[cleanedUUID].status = "deleted"
        del(outPath + cleanedUUID + "/", { force: true })
        fileUpdateEvent(uuid)
    } catch (e) {
        console.log(`Couldn't delete ${uuid}`)
    }
}

const checkUUIDs = (uuids) => {
    if (typeof uuids === "string") {
        if (typeof uploads[uuids] === "object") {
            return [uuids]
        }
    } else if (typeof uuids === "object") {
        let availableUUIDs = []
        uuids.forEach((uuid) => {
            if (typeof uploads[uuids] === "object") {
                availableUUIDs.push(uuid)
            }
        })
        return availableUUIDs
    }
}

const crush = (UUID, options = "{}") => {
    const file = uploads[UUID]
    processFile(UUID, path.basename(file.In.Source), file.Path + "/source" + file.In.Extension, outPath, JSON.parse(options))
}

const recrush = (UUID, options = "{}") => {
    const file = uploads[UUID]
    processFile(UUID, path.basename(file.In.Source), file.Path + "/source" + file.In.Extension, outPath, JSON.parse(options))
}

sendMessage({
    type: "ready"
})

console.log(`\x1b[34mServer Ready!\x1b[0m`)
