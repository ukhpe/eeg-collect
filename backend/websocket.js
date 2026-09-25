const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const url = require("url");
//const prisma = require('./db');

const port = process.env.PORT || 3000;
const RECORDINGS_DIR = path.join(__dirname, "recordings");

// Ensure the recordings directory exists
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR);
}


/**
 * central log-function
 * writes errors and warnings in file
 */
const writeLog = (targetDir, mode, level, contextMessage, errorDetails = "") => {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level.toUpperCase()}] [MODE: ${mode}] ${contextMessage}\nDetails: ${errorDetails}\n------------------------------------------\n`;

  // live feedback in server terminal
  console.log(`[${level.toUpperCase()}] ${contextMessage}`, errorDetails ? `\nDetails: ${errorDetails}` : "");


  const logFilePath = path.join(targetDir, "session_error.log");

  fs.appendFile(logFilePath, logMessage, (fsErr) => {
    if (fsErr) {
      console.error("critical system error: logfile couldn't be written to !", fsErr);
    }
  });
};


// Create WebSocket server
const server = new WebSocket.Server({ port });

server.on("connection", (ws, req) => {
  console.log("WebSocket connection established");
  const location = url.parse(req.url, true);
  const pathParts = location.pathname.split("/");
  const mode = pathParts[2];
  const participant = pathParts[3]; // Assuming the path is /websocket/participant1
  console.log(`mode: ${mode} participant: ${participant}`);

  const researcher = "default_researcher" //changed when adding the IAM
  const study = "default_study" //changed when adding the IAM

  let hasMainRecordingStarted = false;

  const startTime = Math.floor(new Date().getTime() / 1000);

  //creating new directory for the files
  const sessionDir = path.join(RECORDINGS_DIR, researcher, study, participant, startTime.toString());


  // ensure directory for recordings exists
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const fileName = `Recording.csv`;
  const filePath = path.join(sessionDir, fileName);
  const writeStream = fs.createWriteStream(filePath);

  const deviceSetupFileName = `Setup.csv`;
  const deviceSetupFilePath = path.join(sessionDir, deviceSetupFileName);
  const setupWriteStream = fs.createWriteStream(deviceSetupFilePath);

/*
  // new Sesion will be added to Prisma DB
  const newSession = prisma.study.create({
    data: {
      //studyId: defaultStudy.id, // here add the id of the study which the session belongs to
      folderPath: sessionDir
    }
  });

 */


  if (mode === "daisy") {
    // Write the CSV header
    writeStream.write(
      "Index;Datetime;sampleNumber;timestamp;A1;A2;A3;A4;A5;A6;A7;A8;A9;A10;A11;A12;A13;A14;A15;A16;Accel0;Accel1;Accel2\n",
    );
    setupWriteStream.write(
      "Index;Datetime;sampleNumber;timestamp;A1;A2;A3;A4;A5;A6;A7;A8;A9;A10;A11;A12;A13;A14;A15;A16;Accel0;Accel1;Accel2\n",
    );
  } else if (mode === "cyton") {
    // Write the CSV header
    writeStream.write(
      "Index;Datetime;sampleNumber;timestamp;A1;A2;A3;A4;A5;A6;A7;A8;Accel0;Accel1;Accel2;Note\n",
    );
    setupWriteStream.write(
      "Index;Datetime;sampleNumber;timestamp;A1;A2;A3;A4;A5;A6;A7;A8;Accel0;Accel1;Accel2;Note\n",
    );
  }
  let index = 0;
  let previousData = null;

  ws.on("message", (message) => {
    try {
      if (message.toString() === "heartbeat") {
        return;
      }

      // catch frontend logs
      if (message.toString().startsWith("{") && message.toString().endsWith("}")) {
        const parsed = JSON.parse(message);

        if (parsed.event === "frontend_log") {
          writeLog(
            sessionDir,
            mode,
            parsed.level.toUpperCase(),
            `[Frontend] ${parsed.message}`,
            parsed.details
          );
          return;
        }
      }

      if (message.toString() === "Audio File Started") {
        index += 1;
        const datetime = new Date().toLocaleString();
        const csvRow = `${index};${datetime};;;;;;;;;;;;;;Audio Recording Started\n`;

        !hasMainRecordingStarted
            ? setupWriteStream.write(csvRow)
            : writeStream.write(csvRow);

        console.log("Audio File Started");
        return;
      }

      if (message.toString() === "Audio File Ended") {
        index += 1;
        const datetime = new Date().toLocaleString();
        const csvRow = `${index};${datetime};;;;;;;;;;;;;;Audio Recording Ended\n`;

        !hasMainRecordingStarted
            ? setupWriteStream.write(csvRow)
            : writeStream.write(csvRow);

        console.log("Audio File Ended");
        return;
      }

      if (message.toString() === "Setup Finished") {
        hasMainRecordingStarted = true;
        return;
      }

      let data;
      if (mode === "daisy") {
        data = decodeDaisyData(message);
        if (data) {
          if (data.sampleNumber % 2 === 0) {
            // Combine with previous odd sample
            if (
                previousData &&
                previousData.sampleNumber === data.sampleNumber - 1
            ) {
              const combinedData = {
                ...previousData,
                ...data,
              };
              index += 1;
              const datetime = new Date(combinedData.timestamp).toLocaleString();
              const csvRow = `${index};${datetime};${combinedData.sampleNumber};${combinedData.timestamp};${combinedData.A1};${combinedData.A2};${combinedData.A3};${combinedData.A4};${combinedData.A5};${combinedData.A6};${combinedData.A7};${combinedData.A8};${combinedData.A9};${combinedData.A10};${combinedData.A11};${combinedData.A12};${combinedData.A13};${combinedData.A14};${combinedData.A15};${combinedData.A16};${combinedData.Accel0};${combinedData.Accel1};${combinedData.Accel2}\n`;
              writeStream.write(csvRow);
              previousData = null; // Reset for next pair
            }
          } else {
            // Store odd sample data
            previousData = data;
          }
        }
      } else if (mode === "cyton") {
        data = decodeCytonData(message);

        if (!data) {
          return;
        }

        index += 1;
        const datetime = new Date(data.timestamp).toLocaleString();
        const csvRow = `${index};${datetime};${data.sampleNumber};${data.timestamp};${data.A1};${data.A2};${data.A3};${data.A4};${data.A5};${data.A6};${data.A7};${data.A8};${data.Accel0};${data.Accel1};${data.Accel2}\n`;

        hasMainRecordingStarted
            ? writeStream.write(csvRow)
            : setupWriteStream.write(csvRow);
      } else {
        // Store odd sample data
        previousData = data;
      }
    } catch (globalMsgError) {
      // catches unexpected critical errors
      writeLog(sessionDir, mode, "ERROR", "critical runtime error during stream-data-process", globalMsgError);
    }
  });

  // Security from unexpected loss of connection
  ws.on("error", (wsError) => {
    writeLog(sessionDir, mode, "ERROR", "WebSocket connection-error occurred", wsError);
  });

  ws.on("close", () => {
    writeStream.end();
    console.log(`WebSocket connection closed for participant: ${participant}`);
  });

  const decodeDaisyData = (message) => {
    const str = message.toString();
    const numbers = str.split(",").map(Number);

    const chunk = new Uint8Array(numbers);
    const odd = chunk[1] % 2 !== 0;
    const byteArray = chunk.slice(1, -1);
    const sampleNumber = chunk[1];

    const data = {
      sampleNumber,
      timestamp: new Date().getTime(),
      Accel0: 0,
      Accel1: 0,
      Accel2: 0,
    };

    if (chunk[chunk.length - 1] === 192) {
      data.Accel0 = interpret16bitAsInt32(chunk.slice(26, 28)) * 0.000125;
      data.Accel1 = interpret16bitAsInt32(chunk.slice(28, 30)) * 0.000125;
      data.Accel2 = interpret16bitAsInt32(chunk.slice(30, 32)) * 0.000125;
    }

    for (let i = 2; i <= 24; i += 3) {
      const channelData =
        interpret24bitAsInt32(byteArray.slice(i - 1, i + 2)) * 0.0223517445;
      const channelName = `A${Math.ceil((i - 1) / 3) + (odd ? 0 : 8)}`;
      data[channelName] = channelData;
    }

    return data;
  };

  const decodeCytonData = (message) => {
    const str = message.toString();
    const numbers = str.split(",").map(Number);

    const chunk = new Uint8Array(numbers);
    const byteArray = chunk.slice(1, -1);
    const sampleNumber = chunk[1];
    const data = {
      sampleNumber,
      timestamp: new Date().getTime(),
      Accel0: interpret16bitAsInt32(chunk.slice(26, 28)) * 0.000125,
      Accel1: interpret16bitAsInt32(chunk.slice(28, 30)) * 0.000125,
      Accel2: interpret16bitAsInt32(chunk.slice(30, 32)) * 0.000125,
    };

    for (let i = 2; i <= 24; i += 3) {
      const channelData =
        interpret24bitAsInt32(byteArray.slice(i - 1, i + 2)) * 0.0223517445;
      const channelName = `A${Math.ceil((i - 1) / 3)}`;
      data[channelName] = channelData;
    }

    return data;
  };
});



function interpret24bitAsInt32(byteArray) {
  if (byteArray.length !== 3) {
    throw new Error("Byte array must have exactly 3 elements");
  }

  let newInt =
    ((0xff & byteArray[0]) << 16) |
    ((0xff & byteArray[1]) << 8) |
    (0xff & byteArray[2]);

  if ((newInt & 0x00800000) > 0) {
    newInt |= 0xff000000;
  } else {
    newInt &= 0x00ffffff;
  }

  return newInt;
}

function interpret16bitAsInt32(byteArray) {
  let newInt = ((0xff & byteArray[0]) << 8) | (0xff & byteArray[1]);

  if ((newInt & 0x00008000) > 0) {
    newInt |= 0xffff0000;
  } else {
    newInt &= 0x0000ffff;
  }

  return newInt;
}

 console.log(`Server is running on http://localhost:${port}`);
