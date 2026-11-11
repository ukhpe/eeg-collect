import { useRoute } from "vue-router";
import { isEmpty, throttle } from "lodash";
import { Store } from "vuex";

import {db, EegData} from "@/utils/db";
import { useStore } from "@/store";
import {
  getEncodedCytonCommand,
  getReadableTimestamp,
  interpret16bitAsInt32,
  interpret24bitAsInt32,
  URL_PARAMS,
  URLs,
} from "@/utils/helpers";
import { computed, ref, watch } from "vue";
import CHANNEL_ASSIGNMENT from "@/config/channelAssignment.json";
import channelAssignment from "@/config/channelAssignment.json";
import { ConnectionMode, State } from "@/store/utils/storeTypes";
import { CHECK_CONNECTED_DEVICE_STATUS } from "@/scripts/cyton";
import {
  ConnectedDeviceStatus,
  CytonBoardCommands,
  DEFAULT_OPEN_BCI_SERIAL_DATA,
  DEFAULT_OPEN_BCI_SERIAL_DATA_RMS,
  OPEN_BCI_CYTON_DATA_DEFAULT_VALUE,
  OpenBCICytonData,
  OpenBCISerialData,
  RecordingMode,
  SerialDataRMS,
} from "@/utils/openBCISerialTypes";
import { filter_setup, filter_signal } from "@/utils/fir-filter";

// ---- BROWSER CACHE ----
// Shared by all useOpenBCIUtils() instances, so every component flushes and
// syncs the same queue (otherwise two instances could send the same items twice).

// Number of chunks collected in memory before they are written to Dexie,
// to reduce the number of database writes and reads.
const DEXIE_BATCH_SIZE = 50;
let dexieBatchBuffer: EegData[] = [];
let syncPromise: Promise<boolean> | null = null;

// bc: Remembers whether "Setup Finished" was already sent to the backend in this session.
// bc: Sent along when reconnecting, so the backend keeps writing to Recording.csv.
let isSetupFinished = false;

// bc: Delay between two reconnect attempts after the WebSocket connection was lost
const RECONNECT_DELAY_MS = 2000;

// Clears the Dexie db once per session, to avoid old data being sent to the backend
const clearBrowserCache = async () => {
  dexieBatchBuffer = [];
  try {
    await db.eegData.clear();
    console.log("Dexie-Databank successfully cleared on start.");
  } catch (error) {
    console.error("Error clearing the Dexie database: ", error);
  }
};

export const useConfigureParticipantId = () => {
  const store = useStore();
  const UrlRoute = useRoute();

  const participantId = computed(
    () => UrlRoute.query[URL_PARAMS.participantIdParam],
  );

  if (store.state.participantId) {
    return;
  }

  watch(
    () => participantId.value,
    () => {
      participantId.value
        ? store.commit("setParticipantId", {
            participantId: `${participantId.value}`,
          })
        : store.commit("setParticipantIdModalOpen");
    },
    { immediate: true },
  );
};

export const useWebsocketConnection = async (): Promise<WebSocket | null> => {
  const store = useStore();
  const webSocket = computed(() => store.state.webSocket);
  const participantId = computed(() => store.state.participantId);

  if (webSocket.value) {
    console.log("WebSocket already exists");
    return webSocket.value;
  }

  const UrlRoute = useRoute();
  const channelConfig = computed(
    () => UrlRoute.query[URL_PARAMS.channelConfig],
  );
  const studyId = computed(() => UrlRoute.query[URL_PARAMS.studyIdParam]);
  const channelAssignment = CHANNEL_ASSIGNMENT[`${channelConfig.value}`] || {};
  const mode =
    Object.keys(channelAssignment).length > 8
      ? ConnectionMode.DAISY
      : ConnectionMode.CYTON;

  if (
    !channelConfig.value ||
    !channelAssignment ||
    !mode ||
    !participantId.value ||
    !studyId.value
  ) {
    return null;
  }

  // bc: URL without resume parameters, used for the first connection and for reconnects
  const baseUrl = `${URLs.WEB_SOCKET_URL}${mode}/${participantId.value}/?studyId=${studyId.value}`;

  // bc: Opens a new WebSocket after the connection was lost and asks the backend to
  // bc: continue the same session (same folder and files) instead of starting a new one.
  // bc: Retries until it succeeds. The cached data is then sent by the watcher in useOpenBCIUtils.
  let isReconnectScheduled = false;
  const scheduleReconnect = () => {
    if (isReconnectScheduled) return;
    isReconnectScheduled = true;

    setTimeout(async () => {
      isReconnectScheduled = false;

      const sessionFolder = store.state.sessionFolder;
      const resumeParams = sessionFolder
        ? `&resume=${encodeURIComponent(sessionFolder.startTime)}&setupFinished=${isSetupFinished ? 1 : 0}`
        : "";

      try {
        console.log("bc: trying to reconnect WebSocket");
        const newSocket = await createWebSocket(baseUrl + resumeParams);
        store.commit("setWebSocket", { websocket: newSocket });
        console.log("bc: WebSocket reconnected");
      } catch (error) {
        scheduleReconnect();
      }
    }, RECONNECT_DELAY_MS);
  };

  const createWebSocket = (url: string): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      // bc: The connection counts as ready when the backend sent "session_folder",
      // bc: because the backend only sends it after it is ready to receive data.
      let isReady = false;

      socket.onopen = () => {
        console.log("WebSocket connection opened!");
      };

      socket.onerror = (error) => {
        console.error("WebSocket error:", error);
        if (!isReady) reject(error); // bc: only relevant while connecting
      };

      // bc: Closed before it was ready (e.g. backend rejected it) -> attempt failed
      socket.onclose = () => {
        if (!isReady) reject(new Error("WebSocket closed before it was ready"));
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== "string" || !event.data.startsWith("{")) {
          return;
        }

        try {
          const parsed = JSON.parse(event.data);

          if (parsed.event === "session_folder") {
            store.commit("setSessionFolder", {
              sessionFolder: {
                researcherId: parsed.researcherId,
                studyId: parsed.studyId,
                participantId: parsed.participantId,
                startTime: parsed.startTime,
              },
            });

            // bc: Backend is ready -> hand out the socket (before: on open)
            if (!isReady) {
              isReady = true;

              // bc: From now on a lost connection triggers a reconnect.
              // bc: A failed attempt is handled by the catch in scheduleReconnect.
              socket.onclose = () => {
                console.log("bc: WebSocket connection lost");
                scheduleReconnect();
              };

              resolve(socket);
            }
          }
        } catch (error) {
          // Not a JSON control message (e.g. raw EEG data) — ignore
        }
      };
    });

  // A new connection starts a new session in the backend
  await clearBrowserCache();
  isSetupFinished = false; // bc: new session, setup not finished yet

  console.log("A");
  const ws = await createWebSocket(baseUrl); // bc: uses the shared baseUrl

  console.log("B");

  store.commit("setConnectionMode", { connectionMode: mode });
  store.commit("setWebSocket", { websocket: ws });

  return ws;
};

export const useOpenBCIUtils = () => {


  const logToBackend = (level: 'warn' | 'error', message: string, details?: any) => {
    if (level === 'error') console.error(`${message}`, details || '');
    if (level === 'warn') console.warn(`${message}`, details || '');

    const serializedDetails = details instanceof Error
      ? JSON.stringify({ name: details.name, message: details.message, stack: details.stack })
      : details
        ? JSON.stringify(details)
        : null;

    if (ws.value && ws.value.readyState === WebSocket.OPEN) {
      ws.value.send(JSON.stringify({
        event: "frontend_log",
        level: level,
        message: message,
        details: serializedDetails
      }));
    }
  };

  // ---- STATE ----

  const isRecordingPaused = ref<boolean>(false);
  const isReadingDataStopped = ref<boolean>(false);

  // ---- STATE: APIs ----

  const signalRMS = computed(() => {
    const a = bandPassFilteredSignalsThrottled.value;
    return getThrottledRMS();
  });

  const throttledBuffer = computed<OpenBCISerialData[]>(() => {
    const b = rollingBuffer.value;
    return getThrottledBuffer();
  });

  const isImpedanceCheckRunning = ref<boolean>(false);
  const impedanceCheckChannel = ref<number>(1);
  const impedanceDataRaw = ref<any>({});

  // ---- STATE: Internal ----

  const store = useStore();
  const ws = computed(() => store.state.webSocket);
  const sessionFolder = computed(() => store.state.sessionFolder);

  const participantId = computed(() => store.state.participantId);

  const mode = computed(() => store.state.mode);
  const port = computed(() => store.state.webSerial.port);
  const reader = computed(() => store.state.webSerial.reader);
  const recordingMode = ref<RecordingMode>(RecordingMode.RECORDING);
  const startRecordingTime = ref<string>("");
  const isRecording = ref<boolean>(false);

  const impedanceRecordingStartTime = ref<string>("");
  const data = ref<OpenBCICytonData>(OPEN_BCI_CYTON_DATA_DEFAULT_VALUE);

  // Buffer storing complete cyton chunks.
  const rollingBuffer = ref<OpenBCISerialData[]>([]);

  const filterObj = ref<any>(filter_setup(250, 824));

  const bandFilteredBufferCached = ref<number[][]>([
    [],
    [],
    [],
    [],
    [],
    [],
    [],
    [],
  ]);
  function applyHighpassFilter(eegData: number[]) {
    const filteredArray: number[] = filter_signal(
      eegData,
      824,
      filterObj.value,
    );

    return filteredArray;
  }

  const getBandFilteredData = () => {
    const array: number[][] = [];

    throttledBuffer.value.map((serialData, index) => {
      for (let i = 0; i < 8; i++) {
        if (!array[i]) {
          array[i] = [];
        }
        array[i].push(serialData[`A${i + 1}` as keyof OpenBCISerialData]);
      }
    });

    const filteredData: number[][] = [];

    array.map((subArray) => filteredData.push(applyHighpassFilter(subArray)));

    return filteredData;
  };

  const bandPassFilteredSignalsThrottled = computed<number[][]>(() => {
    bandFilteredBufferCached.value =
      getBandFilteredData() ?? bandFilteredBufferCached.value;

    return bandFilteredBufferCached.value;
  });

  const getThrottledBuffer = throttle(() => {
    return rollingBuffer.value;
  }, 500);

  const nodeRMSsCached = ref<SerialDataRMS>({
    ...DEFAULT_OPEN_BCI_SERIAL_DATA_RMS,
  });
  const getThrottledRMS = throttle(() => {
    Object.keys(nodeRMSsCached.value).map((AKey, nodeRMSCachedIndex) => {
      bandFilteredBufferCached.value.map((subArray, index) => {
        if (nodeRMSCachedIndex !== index) {
          return;
        }

        if (subArray.length === 0) {
          return;
        }

        // Calculate RMS for each sub-array
        const sumOfSquares = subArray.reduce(
          (sum, value) => sum + value ** 2,
          0,
        );
        const RMS = Math.sqrt(sumOfSquares / subArray.length);

        nodeRMSsCached.value[AKey as keyof SerialDataRMS] = RMS;
      });
    });

    return nodeRMSsCached.value;
  }, 500);

  // ---- METHODS ----

  // ---- METHODS: APIs ----

  const stopRecording = async () => {
    isRecording.value = false;

    try {
      // Check if the port is writable before writing data
      if (port.value && port.value.writable) {
        const writer = port.value.writable.getWriter();

        try {
          await writer.write(
            getEncodedCytonCommand(CytonBoardCommands.STOP_STREAMING),
          );
          console.log("Cyton Streaming stopped");
        } finally {
          writer.releaseLock();
        }
      } else {
        logToBackend("error", "Serial port is not writable");
      }
    } catch (error) {
      logToBackend("error", "Error stopping recording:", error);
    }

    // Send the last chunks that did not fill a whole batch
    await flushCacheToBackend();
  };

  const startRecording = async () => {
    // bc: Only a session is required. The connection itself may be lost at the moment,
    // bc: "Setup Finished" is cached and sent after the reconnect.
    if (!ws.value) {
      logToBackend("error", "No WebSocket session, recording not started.");
      return;
    }

    // bc: "Setup Finished" goes through the cache behind all setup data that was recorded
    // bc: before it, so the backend switches to Recording.csv at the right point.
    console.log("Setup Finished");
    await queueControlMessage("Setup Finished");
    await commandBoardStartStreamingData(RecordingMode.SESSION_RECORDING);

    startSignalQualityCheck();
  };

  const isWhileRunning = ref<boolean>(false);

  // Like readData() in cyton.js
  const startSignalQualityCheck = async () => {
    isRecording.value = true;

    let chunkBuffer: any[] = []; // Buffer to accumulate bytes until a complete chunk is formed
    let headerFound = false;
    let lastDataTimestamp = Date.now();
    let timeoutId: number;

    const readAndDecodeDataFromStream = async (
      specifiedRecordingMode?: RecordingMode,
      caller?: string,
    ) => {
      if (caller) console.log(caller);

      while (isRecording.value) {
        const { value, done } = await readFromStream();

        // console.log("received from stream: ", value);

        if (done) {
          console.log("Stream disconnected, checking status");
          if (isRecording.value) {
            console.log("Stream disconnected, attempting to reconnect");
            if (reader.value) {
              console.log(reader.value);
              reader.value.releaseLock();
              break;
            }
            continue;
          } else {
            console.log("Stream disconnected, stopping read");
            if (reader.value) {
              reader.value.releaseLock();
              break;
            }
          }
        }

        lastDataTimestamp = Date.now(); // Update timestamp on new data
        resetTimeout();

        if (!value) {
          console.log("Warning: Received null or undefined value from reader.");

          continue;
        }

        // Process received chunk
        for (let i = 0; i < value.length; i++) {
          try {
            // Check if the header is found
            if (!headerFound && value[i] === 160) {
              headerFound = true;
            } else if (!headerFound && !headerFound) {
              const text = new TextDecoder().decode(value);
              // console.log(text);
            }

            if (headerFound) {
              chunkBuffer.push(value[i]);
            }
          } catch (error) {
            // console.error("Error in first part of for loop:", error);
            // logErrorDetails(error, buffer, isRecording.value);
          }

          try {
            // Check if a complete chunk is formed
            // Decode the chunk
            // Stop receiving data if the stop byte is found
            if (value[i] < 192 || value[i] > 198 || chunkBuffer.length <= 30) {
              // TODO: I assume this case is not caught: What happens if the above is not executed and the buffer not reset?
              // console.log("Unsure what to do with rest of chunk?");

              continue;
            }

            // catch incomplete chunks and reset
            if (chunkBuffer.length != 33) {
              chunkBuffer = []; // Reset buffer for the next chunk
              headerFound = false;
              continue;
            }

            headerFound = false;

            if (
              specifiedRecordingMode === RecordingMode.RECORDING ||
              recordingMode.value === RecordingMode.RECORDING
            ) {
              // console.log("---- Recording Mode ----");
              // ---- RECORDING MODE ----

              switch (mode.value) {
                case ConnectionMode.CYTON: {
                  const data = decodeCytonData(chunkBuffer);

                  if (data) {
                    if (unthrottledBuffer.length > 1250) {
                      unthrottledBuffer.shift();
                    }

                    unthrottledBuffer.push(data);

                    // Use the throttled function to update rollingBuffer
                    throttledUpdateRollingBuffer(unthrottledBuffer);


                  }
                  break;
                }
                case ConnectionMode.DAISY:
                  // decodeDaisy(buffer);
                  break;
              }

              saveChunkToDexie([...chunkBuffer]);

            } else if (
              specifiedRecordingMode === RecordingMode.IMPEDANCE ||
              recordingMode.value === RecordingMode.IMPEDANCE
            ) {
              // console.log("---- Impedance Mode ----");
              // ---- IMPEDANCE MODE ----

              switch (mode.value) {
                case ConnectionMode.CYTON: {
                  decodeChunkImpedance(chunkBuffer);
                  break;
                }
                case ConnectionMode.DAISY:
                  // decodeDaisy(buffer);
                  break;
              }
            } else if (
              specifiedRecordingMode === RecordingMode.SESSION_RECORDING ||
              recordingMode.value === RecordingMode.SESSION_RECORDING
            ) {
              // console.log("---- Session Mode ----");
              // ---- SESSION RECORDING MODE ----

              switch (mode.value) {
                case ConnectionMode.CYTON: {

                  saveChunkToDexie([...chunkBuffer]);

                  break;
                }
                case ConnectionMode.DAISY:
                  // decodeDaisy(buffer);
                  break;
              }
            }

            chunkBuffer = []; // Reset buffer for the next chunk
          } catch (error) {
            logToBackend("error", "Error in second part of for loop:", error);
          }
        }
      }

      isWhileRunning.value = false;
      isReadingDataStopped.value = true;
      console.log("While ended");
    };

    watch(
      isReadingDataStopped,
      (newValue) => {
        console.log("isReadingDataStopped changed to " + newValue);
        if (newValue && isRecording.value && !isWhileRunning.value) {
          console.log("Restarting Data Reading");
          isReadingDataStopped.value = false;
          isWhileRunning.value = true;
          readAndDecodeDataFromStream(
            recordingMode.value,
            "watch IsReadingData",
          );
        }
      },
      { immediate: true },
    );

    watch(recordingMode, async (newValue) => {
      console.log("recordingMode changed to " + recordingMode.value);
      if (newValue) {
        await stopRecording().then(() => {
          data.value = OPEN_BCI_CYTON_DATA_DEFAULT_VALUE;
          isWhileRunning.value = true;
          readAndDecodeDataFromStream(newValue, "watch recordingMode");
        });
      }
    });

    watch(
      isRecording,
      (newValue) => {
        console.log(
          "isRecording changed to " + newValue + ". Loop running: " + newValue,
        );
        console.log(recordingMode.value);
        if (newValue && !isWhileRunning.value) {
          chunkBuffer = [];
          isWhileRunning.value = true;
          readAndDecodeDataFromStream(recordingMode.value, "watch isRecording");
        }
      },
      { immediate: true },
    );

    watch(isRecordingPaused, (newValue) => {
      console.log("isRecordingPaused " + newValue);

      if (!newValue && !isWhileRunning.value) {
        isWhileRunning.value = true;
        readAndDecodeDataFromStream(
          recordingMode.value,
          "watch isRecordingPaused",
        );
      }
    });

    const resetTimeout = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        if (isRecording.value && Date.now() - lastDataTimestamp >= 3000) {
          console.log(
            "no new data received since 10 seconds, restarting stream",
          );
          commandBoardStartStreamingData(RecordingMode.SESSION_RECORDING);
          isReadingDataStopped.value = false;
          isWhileRunning.value = true;
          readAndDecodeDataFromStream(
            RecordingMode.SESSION_RECORDING,
            "caller resetTimeout",
          );
        }
      }, 3000);
    };

    // Start the initial timeout check
    resetTimeout();
    // let stop = false;

    const unthrottledBuffer: OpenBCISerialData[] = [];
  };

  const throttledUpdateRollingBuffer = throttle((data: any) => {
    rollingBuffer.value = [...data];
  }, 1000); // Adjust the delay (1000ms) as needed

  const setupSerialConnection = async ({
    setIsLoadingModalShown,
  }: {
    setIsLoadingModalShown: (arg: boolean) => void;
  }): Promise<ConnectedDeviceStatus | boolean> => {
    let returnStatus: ConnectedDeviceStatus | boolean = false;
    try {
      const port: SerialPort = await navigator.serial.requestPort();

      store.commit("setWebSerialPort", { port: port });

      if (setIsLoadingModalShown !== undefined) {
        setIsLoadingModalShown(true);
      }

      if (!port.readable || !port.writable) {
        await port.open({ baudRate: 115200, bufferSize: 1000000 });
      }

      const reader: ReadableStreamDefaultReader<Uint8Array> =
        port.readable.getReader();

      console.log("reader");
      console.log(reader);
      store.commit("setWebSerialReader", { reader: reader });

      const isCorrectDeviceConnected = await checkConnectedDevice(store);

      console.log("isCorrectDeviceConnected");
      console.log(isCorrectDeviceConnected);

      if (isCorrectDeviceConnected === ConnectedDeviceStatus.SUCCESS) {
        console.log("Correct device connected");
        // this.readData();
        returnStatus = ConnectedDeviceStatus.SUCCESS;
      } else if (
        isCorrectDeviceConnected ===
        ConnectedDeviceStatus.DONGLE_CONNECTED_BUT_HEADSET_NOT_FOUND
      ) {
        console.log("Dongle connected but Headset not found");
        returnStatus =
          ConnectedDeviceStatus.DONGLE_CONNECTED_BUT_HEADSET_NOT_FOUND;
      } else {
        console.log("No Data Streamed");
        returnStatus = ConnectedDeviceStatus.NO_DATA_STREAMED;
      }

      return returnStatus;
    } catch (error) {
      logToBackend("error", "Error connecting to serial port:", error);

      if (port.value && !isEmpty(port.value.getInfo())) {
        console.log("Port Info");
        console.log(port.value.getInfo());
        await port.value.close();
        console.log("Serial port closed due to error");
      }

      if (reader.value && !reader.value.closed) {
        reader.value.releaseLock();
        console.log("Reader released due to error");
      }

      return false;
    } finally {
      if (setIsLoadingModalShown !== undefined) {
        setIsLoadingModalShown(false);
      }

      // TODO: Release the reader when the app is unmounted, but not here!
    }
  };

  const runImpedanceCheck = async () => {
    const urlParams = new URLSearchParams(window.location.search);
    const channelConfig = urlParams.get("wlmtdoqtqe");

    resetImpedance(channelConfig ?? "E");

    await defaultChannelSettings();

    recordingMode.value = RecordingMode.IMPEDANCE;

    if (!port.value || !port.value.writable) {
      logToBackend("error", "Serial port is not writable, Imdpedance check failed");

      return;
    }

    const writer = port.value.writable.getWriter();
    await writer
      .write(new TextEncoder().encode(CytonBoardCommands.STOP_STREAMING))
      .then(() => {
        isRecordingPaused.value = true;
        console.log("Recording paused");
      })
      .finally(() => writer.releaseLock());

    data.value = OPEN_BCI_CYTON_DATA_DEFAULT_VALUE;

    // Channel 1 has to be checked twice, due to a bug which calculates a wrong impedance value for the first check.
    await runImpedanceCheckForChannel(1).then(() => {
      isImpedanceCheckRunning.value = false;
    });

    for (let i = 1; i <= 8; i++) {
      recordingMode.value = RecordingMode.IMPEDANCE;
      console.log("IIIIIIIIIIIIII");
      isImpedanceCheckRunning.value = true;
      impedanceCheckChannel.value = i;
      await runImpedanceCheckForChannel(i).then(() => {
        isImpedanceCheckRunning.value = false;
      });
    }

    await exportImpedanceCSV();
  };

  // bc: Audio markers are cached like the EEG data, so they are not lost on a connection loss
  // bc: (before: sent directly, and dropped if the connection was not open)
  const sendAudioSignalStartMessage = async () => {
    await queueControlMessage("Audio File Started");
  };

  const sendAudioSignalEndMessage = async () => {
    await queueControlMessage("Audio File Ended");
  };

  // ---- METHODS: Internal ----

  // bc: Puts a control message into the cache behind all chunks recorded before it,
  // bc: together with the time it happened. Saved to Dexie right away (not after 50 chunks),
  // bc: so it is not delayed and survives a connection loss.
  const queueControlMessage = async (control: string) => {
    dexieBatchBuffer.push({ timestamp: Date.now(), payload: [], control });

    const batchToSave = dexieBatchBuffer;
    dexieBatchBuffer = [];

    try {
      await db.eegData.bulkAdd(batchToSave);
    } catch (error) {
      logToBackend("error", `Error saving control message "${control}" to Dexie db:`, error);
      return;
    }

    if (ws.value && ws.value.readyState === WebSocket.OPEN) {
      triggerSync();
    }
  };

  // saves a chunk to Dexie db if the batchbuffer is "full", and triggers sync if buffer is full
  const saveChunkToDexie = (chunk: Uint8Array | number[]) => {
    dexieBatchBuffer.push({
      timestamp: Date.now(),
      payload: Array.from(new Uint8Array(chunk)),
    });

    if (dexieBatchBuffer.length >= DEXIE_BATCH_SIZE) {
      const batchToSave = [...dexieBatchBuffer];
      dexieBatchBuffer = [];

      db.eegData.bulkAdd(batchToSave).then(() => {
        if (ws.value && ws.value.readyState === WebSocket.OPEN) {
          triggerSync();
        }
      }).catch((error) => {
        logToBackend("error", "Error saving batch to Dexie db:", error);
      });
    }
  };

  // synchronisation of Dexie db with backend. Only one sync runs at a time,
  // a second call returns the running one. Resolves to false on an error.
  const triggerSync = (): Promise<boolean> => {
    if (!syncPromise) {
      syncPromise = runSync().finally(() => {
        syncPromise = null;
      });
    }
    return syncPromise;
  };

  const runSync = async (): Promise<boolean> => {
    try {
      while (ws.value && ws.value.readyState === WebSocket.OPEN) {
        // bc: Use the same socket for the whole batch, even if the store gets a new one meanwhile
        const socket = ws.value;
        const pendingItems = await db.eegData.limit(DEXIE_BATCH_SIZE).toArray();

        if (pendingItems.length === 0) break;

        const idsToDelete: number[] = [];

        for (const item of pendingItems) {
          // bc: Stop if the connection was lost during the batch. The items that were not
          // bc: sent stay in Dexie and are sent after the reconnect.
          // bc: (A closed WebSocket silently drops send() calls, so they must not be deleted.)
          if (socket.readyState !== WebSocket.OPEN) break;

          if (item.control) {
            // bc: Cached control message -> sent as JSON with the time it happened in the frontend
            socket.send(JSON.stringify({
              event: "control",
              message: item.control,
              timestamp: item.timestamp,
            }));

            // bc: Only now the backend knows that the setup is finished.
            // bc: Needed to resume the session correctly after a reconnect.
            if (item.control === "Setup Finished") {
              isSetupFinished = true;
            }
          } else {
            // --- Timestamp und Payload kombinieren ---
            const payloadBytes = new Uint8Array(item.payload);
            const buffer = new ArrayBuffer(8 + payloadBytes.length);
            const dataView = new DataView(buffer);

            dataView.setFloat64(0, item.timestamp, true); // 8-Byte Timestamp (Little-Endian)

            const combinedArray = new Uint8Array(buffer);
            combinedArray.set(payloadBytes, 8); // Payload ab Offset 8 anhängen

            socket.send(buffer);
          } // bc: end of the EEG data case

          // bc: Only delete items that were actually handed to an open connection
          if (item.id !== undefined) {
            idsToDelete.push(item.id);
          }

          //ws.value.send(new Uint8Array(item.payload));
        }

        await db.eegData.bulkDelete(idsToDelete);
      }
      return true;
    } catch (error) {
      logToBackend("error", "Error during Dexie db sync:", error);
      return false;
    }
  };

  // bc: After a reconnect the store gets a new, open WebSocket.
  // bc: Then send everything that was cached while the connection was lost.
  watch(ws, (newSocket) => {
    if (newSocket && newSocket.readyState === WebSocket.OPEN) {
      triggerSync();
    }
  });

  // Writes the chunks that are still in memory to Dexie and sends everything
  // that was recorded up to now to the backend. Chunks recorded while flushing
  // are left to the normal batch sync.
  const flushCacheToBackend = async () => {
    if (dexieBatchBuffer.length > 0) {
      const batchToSave = dexieBatchBuffer;
      dexieBatchBuffer = [];
      try {
        await db.eegData.bulkAdd(batchToSave);
      } catch (error) {
        logToBackend("error", "Error saving batch to Dexie db:", error);
      }
    }

    try {
      const lastItem = await db.eegData.orderBy("id").last();
      if (lastItem?.id === undefined) return;

      while (
        ws.value &&
        ws.value.readyState === WebSocket.OPEN &&
        (await db.eegData.where("id").belowOrEqual(lastItem.id).count()) > 0
      ) {
        const success = await triggerSync();
        if (!success) break;
      }
    } catch (error) {
      logToBackend("error", "Error while flushing the Dexie db:", error);
    }
  };

  const decodeChunkImpedance = (message: any[]) => {
    const str = message.toString();
    const numbers = str.split(",").map(Number);
    const chunk = new Uint8Array(numbers);

    // Skip first byte (header) and last byte (stop byte)
    const byteArray = chunk.slice(1, -1);
    const sampleNumber = chunk[1];
    data.value["sampleNumber"].push(sampleNumber);
    data.value["timestamp"].push(new Date().getTime());

    // Parse EEG data for all channels
    const eegData = [];

    for (let i = 2; i <= 24; i += 3) {
      const channelData =
        interpret24bitAsInt32(byteArray.slice(i - 1, i + 2)) * 0.5364418669;
      const channelName = `A${Math.ceil((i - 1) / 3)}`;

      // @ts-ignore-next-line: Der meckert, weil der key count vom Typ string ist.
      data.value[channelName as keyof OpenBCICytonData].push(channelData);
      eegData.push(channelData);
    }
    const Acc0 = interpret16bitAsInt32(chunk.slice(26, 28)) * 0.000125;
    const Acc1 = interpret16bitAsInt32(chunk.slice(28, 30)) * 0.000125;
    const Acc2 = interpret16bitAsInt32(chunk.slice(30, 32)) * 0.000125;
    try {
      data.value["Accel0"].push(Acc0);
      data.value["Accel1"].push(Acc1);
      data.value["Accel2"].push(Acc2);
    } catch (e) {
      console.log(e);
    }
  };

  const defaultChannelSettings = async () => {
    try {
      if (port.value && port.value.writable) {
        const writer = port.value.writable.getWriter();
        const command = "C~~"; // Command to start recording
        const commandBytes = new TextEncoder().encode(command);
        await writer.write(commandBytes);
        console.log("Default channel settings applied");

        writer.releaseLock();
      } else {
        logToBackend("error", "Serial port is not writable");
      }
    } catch (error) {
      logToBackend("error", "Error starting recording:", error);
    }
  };

  // Wie configureBoard in cyton.js
  const runImpedanceCheckForChannel = async (channel: number) => {
    const startCommands = [
      "x1000010Xz101Z", // Start impedance check for channel 1
      "x2000010Xz201Z", // Start impedance check for channel 2
      "x3000010Xz301Z", // Start impedance check for channel 3
      "x4000010Xz401Z", // Start impedance check for channel 4
      "x5000010Xz501Z", // Start impedance check for channel 5
      "x6000010Xz601Z", // Start impedance check for channel 6
      "x7000010Xz701Z", // Start impedance check for channel 7
      "x8000010Xz801Z", // Start impedance check for channel 8
    ];
    const resetCommands = [
      "x1060110Xz100Z", // Reset impedance check for channel 1
      "x2060110Xz200Z", // Reset impedance check for channel 2
      "x3060110Xz300Z", // Reset impedance check for channel 3
      "x4060110Xz400Z", // Reset impedance check for channel 4
      "x5060110Xz500Z", // Reset impedance check for channel 5
      "x6060110Xz600Z", // Reset impedance check for channel 6
      "x7060110Xz700Z", // Reset impedance check for channel 7
      "x8060110Xz800Z", // Reset impedance check for channel 8
    ];

    const channelCheckStartCommand = startCommands[channel - 1];
    const channelCheckResetCommand = resetCommands[channel - 1];

    if (!channelCheckStartCommand || !channelCheckResetCommand) {
      logToBackend("error", "Invalid channel index:", channel);

      return;
    }

    try {
      // Check if the port is writable before writing data
      if (!port.value || !port.value.writable) {
        logToBackend("error", "Serial port is not writable");

        return;
      }

      let writer = port.value.writable.getWriter();

      recordingMode.value = RecordingMode.IMPEDANCE;

      await writer.write(new TextEncoder().encode(channelCheckStartCommand)); // Start Impedance Command
      console.log("Impedance check command sent for channel " + channel);
      writer.releaseLock();
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait for 1 seconds
      await commandBoardStartStreamingData(RecordingMode.IMPEDANCE);
      isRecordingPaused.value = false;
      console.log("Waiting for 5 sec"); // Start recording for 5 seconds
      await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait for 5 seconds
      console.log("Impedance check completed for channel " + channel);
      await stopImpedanceRecordingForChannel("A" + channel);
      writer = port.value.writable.getWriter();
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait for 1 seconds
      await writer.write(new TextEncoder().encode(channelCheckResetCommand)); // Reset Command
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait for 1 seconds
      console.log("Reset command sent for channel " + channel);
      writer.releaseLock();
    } catch (error) {
      logToBackend("error", "Error sending commands:", error);
    }
  };

  const stopImpedanceRecordingForChannel = async (channel: string) => {
    try {
      // Check if the port is writable before writing data
      if (!port.value || !port.value.writable) {
        logToBackend("error", "Serial port is not writable");

        return;
      }

      const writer = port.value.writable.getWriter();
      await writer
        .write(new TextEncoder().encode(CytonBoardCommands.STOP_STREAMING))
        .then(() => {
          isRecordingPaused.value = true;
          console.log("Recording paused");
        })
        .finally(() => writer.releaseLock());

      data.value.count = `${data.value[channel as keyof OpenBCICytonData].length}`;
      // Prepare data to send
      // @ts-ignore-next-line
      const raw_data = data.value[channel as keyof OpenBCICytonData].map(
        // @ts-ignore-next-line
        (value) => parseFloat(value),
      ); // Convert values to floats if necessary

      console.log(data.value);
      // Send data to http://localhost:5001/calculate_impedance
      const response = await fetch("/data/calculate_impedance/" + 250, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ data_raw: raw_data, channel: channel }),
      });
      console.log("Data sent to calculate impedance:", raw_data);
      const impedanceValue = await response.json(); // Get impedance value from the response
      impedanceDataRaw.value[channel] = impedanceValue.impedance; // Store impedance value in the global variable
      console.log(
        "Impedance value for channel " + channel + ":",
        impedanceValue.impedance,
      );
    } catch (error) {
      logToBackend("error", "Error stopping recording:", error);
    }

    data.value = OPEN_BCI_CYTON_DATA_DEFAULT_VALUE;
  };

  const resetImpedance = (config: string) => {
    const impedanceArray = [];
    impedanceDataRaw.value = [];
    impedanceCheckChannel.value = 1;
    const assignment = channelAssignment[config];

    for (const channel in assignment) {
      const node_id = assignment[channel];
      const impedanceValue = 0;
      const state = 0;

      impedanceArray.push({
        node_id: node_id,
        state: state,
        impedance: impedanceValue,
      });
    }

    return impedanceArray;
  };

  const decodeCytonData = (message: any): OpenBCISerialData => {
    const str = message.toString();
    const numbers = str.split(",").map(Number);

    const chunk = new Uint8Array(numbers);
    const byteArray = chunk.slice(1, -1);
    const sampleNumber = chunk[1];

    const dataChunk: OpenBCISerialData = {
      ...DEFAULT_OPEN_BCI_SERIAL_DATA,
      sampleNumber: sampleNumber,
      timestamp: new Date().getTime(),
      Accel0: interpret16bitAsInt32(chunk.slice(26, 28)) * 0.000125,
      Accel1: interpret16bitAsInt32(chunk.slice(28, 30)) * 0.000125,
      Accel2: interpret16bitAsInt32(chunk.slice(30, 32)) * 0.000125,
    };

    for (let i = 2; i <= 24; i += 3) {
      const channelData =
        interpret24bitAsInt32(byteArray.slice(i - 1, i + 2)) * 0.0223517445;
      const channelId = `A${Math.ceil((i - 1) / 3)}`;

      dataChunk[channelId as keyof OpenBCISerialData] = channelData;
    }

    // console.log("Data Chunk");
    // console.log(dataChunk);

    return dataChunk;
  };

  /**
   * decodeChunk in cyton.js
   *
   * Send a complete chunk to the WebSocket Server.
   * @param chunk - The chunk of received EEG data to be sent to the server.
   */
  const sendChunkToWebSocket = async (chunk: any[]) => {
    if (ws.value && ws.value.readyState === WebSocket.OPEN) {
      try {
        // @ts-expect-error
        ws.value.send(chunk as ArrayBuffer);
      } catch (err) {
        // console.error("Error sending chunk to WebSocket:", err);
      }
    } else {
      // console.warn("WebSocket not open, chunk not sent.");
    }
  };

  // startReading() in cyton.js
  const commandBoardStartStreamingData = async (mode: RecordingMode) => {
    recordingMode.value = mode;
    isRecording.value = true;
    isRecordingPaused.value = false;
    impedanceRecordingStartTime.value = getReadableTimestamp();

    // Check if the port is writable before writing data
    if (!port.value || !port.value.writable) {
      logToBackend("error", "Serial port is not writable");
      return;
    }

    startRecordingTime.value = getReadableTimestamp();
    try {
      const writer = port.value.writable.getWriter();

      console.log(writer);

      await writer.write(
        getEncodedCytonCommand(CytonBoardCommands.START_STREAMING),
      );
      await writer.write(
        getEncodedCytonCommand(CytonBoardCommands.CONFIGURE_SAMPLING_RATE),
      );
      console.log("Recording started");
      writer.releaseLock();
      isRecording.value = true;
    } catch (error) {
      logToBackend("error", "Error starting recording:", error);
    }
  };

  const checkConnectedDevice = async (store: Store<State>) => {
    console.log(store);
    const reader = store.getters.webSerialReader || {};

    if (!reader) {
      logToBackend("error", "No reader found");
      return CHECK_CONNECTED_DEVICE_STATUS.NO_DATA_STREAMED;
    }

    console.log("in checkConnectedDevice");
    recordingMode.value = RecordingMode.RECORDING;
    await commandBoardStartStreamingData(RecordingMode.RECORDING);
    let buffer = ""; // stores decoded text messages.
    const checkChunkBuffer = []; // Buffer to accumulate bytes until a complete chunk is formed
    let isCheckChunkChecked = false;

    console.log("S");

    // Start the initial timeout check
    while (!isCheckChunkChecked) {
      console.log("W");
      console.log("3333");
      const { value, done }: { value: any; done: boolean } =
        await Promise.race<{ value: any; done: boolean }>([
          readFromStream(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Timeout")), 5000),
          ),
        ]).catch(() => ({ value: null, done: true }));

      console.log("New pair for value, done received.");
      console.log(value);

      if (value) {
        const decodedValue = new TextDecoder().decode(value);
        buffer += decodedValue;
        console.log(decodedValue);

        for (let i = 0; i < value.length; i++) {
          checkChunkBuffer.push(value[i]);
        }

        if (
          buffer.includes(
            "Failure: Communications timeout - Device failed to poll Host$$$",
          )
        ) {
          console.log(
            "Correct Port Selected but Headset was not detected. Please turn your headset on.",
          );
          reader.releaseLock();
          return CHECK_CONNECTED_DEVICE_STATUS.DONGLE_CONNECTED_BUT_HEADSET_NOT_FOUND;
        }
      }

      if (!value) {
        console.log("No value streamed. Possibly wrong port selected.");
        reader.releaseLock();
        return CHECK_CONNECTED_DEVICE_STATUS.NO_DATA_STREAMED;
      }

      for (let i = 0; i < value.length; i++) {
        // If chunk is full
        if (
          value[i] >= 192 &&
          value[i] <= 198 &&
          checkChunkBuffer.length > 30
        ) {
          const data = decodeCytonData(checkChunkBuffer);
          if (data) {
            console.log("data");
            console.log(data);
            // TODO Analyze if Data is believably from an eeg headset.
          }

          isCheckChunkChecked = true;
          return CHECK_CONNECTED_DEVICE_STATUS.SUCCESS;
        }
      }

      if (done) {
        console.log("Stream disconnected, stopping read");
        reader.releaseLock();
        break;
      }
    }
  };

  const retrieveAndResetReader = () => {
    if (!port.value) {
      logToBackend("error", "No port found");
      return;
    }

    const retrievedReader: ReadableStreamDefaultReader<Uint8Array> =
      port.value.readable.getReader();

    store.commit("setWebSerialReader", { reader: retrievedReader });
  };

  const readFromStream = async () => {
    if (!reader.value) {
      logToBackend("error", "No reader found");

      retrieveAndResetReader();

      return { value: null, done: false };
    }

    try {
      const { value, done } = await reader.value.read();

      return { value, done };
    } catch (err) {
      logToBackend("error", "rFS: Error while reading from stream:", err);
      console.log(reader.value);

      console.log("rFS: re-setting reader");
      console.log(reader);
      retrieveAndResetReader();

      // DEBUG ATTEMPT: Try to restart the stream
      if (port.value && port.value.writable) {
        const writer = port.value.writable.getWriter();
        await writer.write(
          new TextEncoder().encode(CytonBoardCommands.START_STREAMING),
        );
        writer.releaseLock();
      }

      // console.log(reader.value);
      return { value: null, done: false }; // Return done as true to stop the loop if there's an error
    }
  };

  const exportImpedanceCSV = async () => {
    const objectKeys = Object.keys(impedanceDataRaw.value);
    const csvContent = parseAndExportImpedance(
      impedanceDataRaw.value,
      objectKeys,
    );
    const startTime = impedanceRecordingStartTime.value
      .replace(" ", "_")
      .replace(/:/g, "-");
    const fileName = `${participantId.value}-${startTime}-Impedance.csv`;

    const formData = new FormData();
    formData.append("fileName", fileName);
    if (sessionFolder.value) {
      formData.append("researcherId", sessionFolder.value.researcherId);
      formData.append("studyId", sessionFolder.value.studyId);
      formData.append("participantId", sessionFolder.value.participantId);
      formData.append("startTime", sessionFolder.value.startTime);
    }
    formData.append("csvContent", csvContent);

    await fetch("/api/save-csv", {
      method: "POST",
      body: formData,
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error("Network response was not ok");
        }
        return response.json();
      })
      .then((data) => {
        console.log("CSV file saved successfully:", data.filePath);
        isRecording.value = false;
      })
      .catch((error) => {
        logToBackend("error", "Error saving CSV file:", error);
      });
  };

  // @ts-ignore-next-line
  const parseAndExportImpedance = (data, objectKeys) => {
    console.log("DATA AND OBJKEYS");
    console.log(data);
    console.log(objectKeys);
    const headers = `Index;Datetime;${objectKeys.join(";")}`;

    // Transpose data
    // @ts-ignore-next-line
    const transposedData = objectKeys.map((key) => {
      if (Array.isArray(data[key])) {
        return data[key];
      } else {
        // If it's a string, create an array with a single element
        return [data[key]];
      }
    });

    // Find the maximum length among the arrays
    // @ts-ignore-next-line
    const maxLength = Math.max(...transposedData.map((arr) => arr.length));

    // Fill shorter arrays with empty strings to match the maximum length
    // @ts-ignore-next-line
    const filledData = transposedData.map((arr) => {
      const diff = maxLength - arr.length;
      return arr.concat(Array(diff).fill(""));
    });

    // Add index and current timestamp
    const timestamp = new Date().toISOString();
    const firstRow = `1;${timestamp};${filledData
      // @ts-ignore-next-line
      .map((arr) => arr[0])
      .join(";")}`;
    const remainingRows = [];
    for (let i = 1; i < maxLength; i++) {
      // @ts-ignore-next-line
      const rowData = filledData.map((arr) => arr[i]);
      remainingRows.push(rowData.join(";"));
    }

    // Combine rows with newline characters
    const csvContent =
      headers + "\n" + firstRow + "\n" + remainingRows.join("\n");

    return csvContent;
  };

  // ---- RETURN ----

  return {
    setupSerialConnection,
    startSignalQualityCheck,
    startRecording,
    stopRecording,
    signalRMS,
    throttledBuffer,
    runImpedanceCheck,
    isImpedanceCheckRunning,
    impedanceCheckChannel,
    sendAudioSignalStartMessage,
    sendAudioSignalEndMessage,
  };
};
