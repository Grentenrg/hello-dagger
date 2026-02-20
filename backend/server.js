const express = require('express');
const { Pool } = require('pg');
const { Kafka } = require('kafkajs');
const { createClient } = require('redis');

const app = express();
app.use(express.json());

// Feature flags based on environment
const ENABLE_POSTGRES = process.env.ENABLE_POSTGRES === 'true';
const ENABLE_REDIS = process.env.ENABLE_REDIS === 'true';
const ENABLE_KAFKA = process.env.ENABLE_KAFKA === 'true';

// Service state
let pgPool = null;
let pgReady = false;
let redisClient = null;
let redisReady = false;
let kafkaProducer = null;
let kafkaConsumer = null;
let kafkaReady = false;
const messages = [];

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Readiness check
app.get('/ready', (req, res) => {
  const ready = {
    postgres: !ENABLE_POSTGRES || pgReady,
    redis: !ENABLE_REDIS || redisReady,
    kafka: !ENABLE_KAFKA || kafkaReady,
  };
  const allReady = ready.postgres && ready.redis && ready.kafka;
  res.status(allReady ? 200 : 503).json(ready);
});

// PostgreSQL endpoints
app.post('/postgres/items', async (req, res) => {
  if (!ENABLE_POSTGRES || !pgReady) return res.status(503).json({ error: 'PostgreSQL not ready' });
  try {
    const { name, value } = req.body;
    const result = await pgPool.query(
      'INSERT INTO items (name, value) VALUES ($1, $2) RETURNING *',
      [name, value]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/postgres/items', async (req, res) => {
  if (!ENABLE_POSTGRES || !pgReady) return res.status(503).json({ error: 'PostgreSQL not ready' });
  try {
    const result = await pgPool.query('SELECT * FROM items');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/postgres/items/:id', async (req, res) => {
  if (!ENABLE_POSTGRES || !pgReady) return res.status(503).json({ error: 'PostgreSQL not ready' });
  try {
    const result = await pgPool.query('SELECT * FROM items WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/postgres/items/:id', async (req, res) => {
  if (!ENABLE_POSTGRES || !pgReady) return res.status(503).json({ error: 'PostgreSQL not ready' });
  try {
    await pgPool.query('DELETE FROM items WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Redis endpoints
app.post('/redis/keys', async (req, res) => {
  if (!ENABLE_REDIS || !redisReady) return res.status(503).json({ error: 'Redis not ready' });
  try {
    const { key, value } = req.body;
    await redisClient.set(key, value);
    res.json({ key, value });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/redis/keys/:key', async (req, res) => {
  if (!ENABLE_REDIS || !redisReady) return res.status(503).json({ error: 'Redis not ready' });
  try {
    const value = await redisClient.get(req.params.key);
    if (value === null) {
      return res.status(404).json({ error: 'Key not found' });
    }
    res.json({ key: req.params.key, value });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/redis/keys/:key', async (req, res) => {
  if (!ENABLE_REDIS || !redisReady) return res.status(503).json({ error: 'Redis not ready' });
  try {
    await redisClient.del(req.params.key);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Kafka endpoints
app.post('/kafka/messages', async (req, res) => {
  if (!ENABLE_KAFKA || !kafkaReady) return res.status(503).json({ error: 'Kafka not ready' });
  try {
    const { topic, message } = req.body;
    await kafkaProducer.send({
      topic,
      messages: [{ value: JSON.stringify(message) }],
    });
    res.json({ success: true, topic, message });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/kafka/messages', (req, res) => {
  if (!ENABLE_KAFKA || !kafkaReady) return res.status(503).json({ error: 'Kafka not ready' });
  res.json(messages);
});

// Retry helper
async function retry(fn, maxRetries = 30, delay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      console.log(`Retry ${i + 1}/${maxRetries}: ${err.message}`);
      if (i === maxRetries - 1) throw err;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// Initialize PostgreSQL
async function initPostgres() {
  if (!ENABLE_POSTGRES) return;

  pgPool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: process.env.POSTGRES_PORT || 5432,
    database: process.env.POSTGRES_DB || 'testdb',
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
  });

  await retry(async () => {
    await pgPool.query('SELECT 1');
  });

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      value TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  pgReady = true;
  console.log('PostgreSQL ready');
}

// Initialize Redis
async function initRedis() {
  if (!ENABLE_REDIS) return;

  redisClient = createClient({
    url: `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`
  });
  redisClient.on('error', err => console.log('Redis Client Error', err));

  await retry(async () => {
    await redisClient.connect();
  });

  redisReady = true;
  console.log('Redis ready');
}

// Initialize Kafka
async function initKafka() {
  if (!ENABLE_KAFKA) return;

  const kafka = new Kafka({
    clientId: 'hello-dagger',
    brokers: [`${process.env.KAFKA_HOST || 'localhost'}:${process.env.KAFKA_PORT || 9092}`],
  });

  const kafkaAdmin = kafka.admin();
  kafkaProducer = kafka.producer();
  kafkaConsumer = kafka.consumer({ groupId: 'hello-dagger-group' });

  await retry(async () => {
    await kafkaAdmin.connect();
  });

  await kafkaProducer.connect();
  await kafkaConsumer.connect();

  try {
    await kafkaAdmin.createTopics({
      topics: [{ topic: 'test-topic', numPartitions: 1, replicationFactor: 1 }],
      waitForLeaders: true,
    });
    console.log('Created test-topic');
  } catch (err) {
    console.log('Topic creation:', err.message);
  }

  await kafkaConsumer.subscribe({ topic: 'test-topic', fromBeginning: true });
  await kafkaConsumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      messages.push({
        topic,
        partition,
        value: message.value.toString(),
        timestamp: Date.now(),
      });
    },
  });

  kafkaReady = true;
  console.log('Kafka ready');
}

// Start server first, then initialize services
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);

  // Initialize services in background
  Promise.all([
    initPostgres().catch(err => console.error('PostgreSQL init failed:', err)),
    initRedis().catch(err => console.error('Redis init failed:', err)),
    initKafka().catch(err => console.error('Kafka init failed:', err)),
  ]).then(() => {
    console.log('All enabled services initialized');
  });
});
