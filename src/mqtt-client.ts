import mqtt from 'mqtt';
import { extractHex, processPacket } from './processor.js';
import { broadcastNode, broadcastEdge, broadcastStats, broadcastPacket, debugLog } from './ws-broadcast.js';

const MQTT_URL = process.env.MQTT_URL ?? 'mqtt://mqtt.eastmesh.au:1883';
const MQTT_TOPIC = 'meshcore/MEL/+/packets';

// Counters reset every stats interval
let rxTotal     = 0; // raw MQTT messages received
let hexFail     = 0; // failed to extract hex from payload
let decodeFail  = 0; // hex extracted but decoder returned null
let decodeOk    = 0; // successfully decoded and stored

let statsTimer: ReturnType<typeof setInterval> | null = null;

export function startMqtt(): mqtt.MqttClient {
  const options: mqtt.IClientOptions = {
    clientId: process.env.MQTT_CLIENT_ID ?? `mmv-${Math.random().toString(16).slice(2, 8)}`,
    clean: true,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
  };

  if (process.env.MQTT_USERNAME) options.username = process.env.MQTT_USERNAME;
  if (process.env.MQTT_PASSWORD) options.password = process.env.MQTT_PASSWORD;

  const client = mqtt.connect(MQTT_URL, options);

  client.on('connect', () => {
    debugLog.info(`[mqtt] connected to ${MQTT_URL}`);
    client.subscribe(MQTT_TOPIC, (err) => {
      if (err) {
        debugLog.error(`[mqtt] subscribe error: ${err.message}`);
      } else {
        debugLog.info(`[mqtt] subscribed to ${MQTT_TOPIC}`);
      }
    });
  });

  client.on('reconnect', () => debugLog.info('[mqtt] reconnecting…'));
  client.on('offline',   () => debugLog.warn('[mqtt] offline'));
  client.on('error',     (err) => debugLog.error(`[mqtt] error: ${err.message}`));

  client.on('message', (topic, payload) => {
    rxTotal++;
    // Extract observer's public key from topic: meshcore/{IATA}/{PUBKEY}/packets
    const parts = topic.split('/');
    const observerKey = parts[2] ?? undefined;

    const hexResult = extractHex(payload);
    if ('error' in hexResult) {
      hexFail++;
      debugLog.warn(`[mqtt] bad payload on ${topic} — ${hexResult.error}`);
      return;
    }

    const { hex } = hexResult;
    const result = processPacket(hex, observerKey);
    if (!result) {
      decodeFail++;
      // per-packet reason already logged by processPacket
      return;
    }

    decodeOk++;
    const pathStr = result.animPath.length >= 2 ? result.animPath.join('→') : '(direct)';
    debugLog.info(
      `[pkt] ${result.packetType.padEnd(12)} hash=${result.hash.slice(0, 8)} ` +
      `nodes=${result.nodes.length} path=${pathStr}`
    );

    // Broadcast topology updates
    for (const node of result.nodes) broadcastNode(node);
    for (const edge of result.edges) broadcastEdge(edge);
    broadcastPacket(result.packetType, result.hash, result.animPath);
  });

  // Broadcast stats + pipeline counters every 5 seconds
  statsTimer = setInterval(() => {
    broadcastStats();
    debugLog.info(
      `[stats] rx=${rxTotal} ok=${decodeOk} hexFail=${hexFail} decodeFail=${decodeFail}`
    );
    rxTotal = hexFail = decodeFail = decodeOk = 0;
  }, 5000);

  return client;
}

export function stopMqtt(): void {
  if (statsTimer) clearInterval(statsTimer);
}
