// netlify/functions/board.js
// v1.0 — Хранилище задачника CRM в Netlify Blobs.
// GET  /.netlify/functions/board       → отдаёт текущий boardData.tasks из Blobs
// POST /.netlify/functions/board       → принимает JSON { tasks, updatedAt }, пишет в Blobs
//
// Хранилище: Blobs store "board-data", ключ "current".
// Значение: { tasks: {<colId>:[<task>,...], ...}, updatedAt: <ms>, savedAt: <iso> }
//
// ВАЖНО: connectLambda(event) перед getStore (Lambda-режим). Дефолтный
// (eventual) consistency — для задачника подходит, последняя запись
// в течение нескольких секунд становится видимой всем.

const { connectLambda, getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  try { connectLambda(event); } catch (e) {}

  try {
    const store = getStore('board-data');

    if (event.httpMethod === 'GET') {
      let rec = null;
      try { rec = await store.get('current', { type: 'json' }); }
      catch (e) { rec = null; }
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({ ok: true, data: rec || null })
      };
    }

    if (event.httpMethod === 'POST') {
      let body = {};
      try { body = JSON.parse(event.body || '{}'); }
      catch (e) {
        return { statusCode: 200, headers: CORS,
          body: JSON.stringify({ ok: false, reason: 'BAD_JSON' }) };
      }
      if (!body || typeof body.tasks !== 'object' || !body.tasks) {
        return { statusCode: 200, headers: CORS,
          body: JSON.stringify({ ok: false, reason: 'NO_TASKS' }) };
      }
      const rec = {
        tasks: body.tasks,
        updatedAt: Number(body.updatedAt) || Date.now(),
        savedAt: new Date().toISOString()
      };
      await store.setJSON('current', rec);
      return { statusCode: 200, headers: CORS,
        body: JSON.stringify({ ok: true, savedAt: rec.savedAt, updatedAt: rec.updatedAt }) };
    }

    return { statusCode: 405, headers: CORS,
      body: JSON.stringify({ ok: false, reason: 'METHOD_NOT_ALLOWED' }) };

  } catch (err) {
    return { statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: false, reason: 'EXCEPTION', error: String(err && err.message || err) }) };
  }
};
