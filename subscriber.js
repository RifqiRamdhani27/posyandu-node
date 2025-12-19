// subscriber.js (final)
const mqtt = require('mqtt');
const express = require('express');
const cors = require('cors');

const MQTT_URL = process.env.MQTT_URL || 'mqtt://broker.emqx.io:1883';
const TOPIC = process.env.TOPIC || 'posyandu/suhu/#';
const PORT = process.env.PORT || 3000;
const NODE_SECRET = process.env.NODE_SECRET || ''; // optional

const client = mqtt.connect(MQTT_URL);
const app = express();
app.use(cors());
app.use(express.json());
let activeTargets = {}; // type -> id
const latest = {}; // key: "<type>_<id>" -> { suhu, ts, topic }

// MQTT subscriptions
client.on('connect', () => {
  console.log('Connected to MQTT broker', MQTT_URL);
  client.subscribe(TOPIC, (err) => {
    if (err) console.error('Subscribe error', err);
    else console.log('Subscribed to', TOPIC);
  });
  // listen for set_id if ESP is subscribed
  client.subscribe('posyandu/cmd/set_id', (err) => {
    if (!err) console.log('Subscribed to posyandu/cmd/set_id');
  });
});

// handle incoming mqtt messages
client.on('message', (topic, message) => {
  try {
    const payload = message.toString();

    // topik suhu: posyandu/suhu/{type}_{id}   e.g. posyandu/suhu/bayi_10
    if (topic.startsWith('posyandu/suhu/')) {
      const last = topic.split('/').pop(); // bayi_10 or balita_7
      const [typePart, idPart] = last.split('_');
      if (!typePart || !idPart) {
        console.log('Malformed topic:', topic);
        return;
      }
      const key = `${typePart}_${idPart}`;
      const suhu = parseFloat(payload);
      if (!isNaN(suhu)) {
        latest[key] = { suhu: parseFloat(suhu.toFixed(1)), ts: Date.now(), topic };
        console.log(`Updated latest[${key}] = ${latest[key].suhu}`);
      } else {
        console.log('Ignored non-numeric payload:', payload);
      }
      return;
    }

    // topik perintah set_id (bisa juga komen dari Laravel)
    if (topic === 'posyandu/cmd/set_id') {
      // payload expected "bayi_10" or "balita_7"
      if (typeof payload === 'string' && payload.includes('_')) {
        const [type, id] = payload.split('_');
        activeTargets[type] = id;
        console.log(`ActiveTargets updated via MQTT: ${type} -> ${id}`);
      } else {
        console.log('Ignored set_id payload malformed:', payload);
      }
      return;
    }

    // ignore others
  } catch (e) {
    console.error('Error on message:', e);
  }
});

// health
app.get('/health', (req, res) => res.json({ ok: true }));

// route to set active id for type
console.log("ROUTE /set-active-id LOADED");

// LARAVEL -> set active (type + id)
app.post('/set-active-id', (req, res) => {
  if (NODE_SECRET) {
    const s = req.headers['x-node-secret'];
    if (!s || s !== NODE_SECRET) return res.status(403).json({ error: 'forbidden' });
  }

  const { type, id } = req.body;
  if (!type || !id) return res.status(400).json({ error: 'type & id required' });

  // store active target
  activeTargets[type] = id;

  // Publish to ESP in format "bayi_10" so ESP can publish to posyandu/suhu/bayi_10
  const payload = `${type}_${id}`;
  client.publish('posyandu/cmd/set_id', payload);

  console.log(`Active set: ${type} -> ${id} (published to posyandu/cmd/set_id = ${payload})`);
  return res.json({ ok: true, active: { type, id } });
});

// LARAVEL -> get latest suhu for given type & id
app.get('/latest/:type/:id', (req, res) => {
  if (NODE_SECRET) {
    const s = req.headers['x-node-secret'];
    if (!s || s !== NODE_SECRET) return res.status(403).json({ error: 'forbidden' });
  }

  const type = req.params.type;
  const id = req.params.id;
  const key = `${type}_${id}`;

  const data = latest[key];
  if (!data) return res.status(204).json({ message: 'No data' });

  return res.json({ suhu: data.suhu, ts: data.ts, topic: data.topic });
});

app.listen(PORT, () => console.log(`Node listener HTTP server running on port ${PORT}`));
