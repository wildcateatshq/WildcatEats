"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createCrowdRouter } = require("./crowd-router");
const { createCrowdStore } = require("./crowd");

test("crowd HTTP API accepts opted-in scores, ranks them, and rejects removal requests", async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "percentle-api-"));
  const store = createCrowdStore(path.join(folder, "scores.json"));
  await store.init();
  const app = express();
  app.use(express.json());
  app.use("/api/percentle/crowd", createCrowdRouter(store, () => "2026-10-06"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(folder, { recursive: true, force: true });
  });

  const url = `http://127.0.0.1:${server.address().port}/api/percentle/crowd`;
  const scores = [10, 20, 30, 40, 50, 60];
  const ids = scores.map((_, index) => `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
  for (let index = 0; index < scores.length; index++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ date: "2026-10-06", id: ids[index], score: scores[index] })
    });
    assert.equal(response.status, 200);
  }

  const rank = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ date: "2026-10-06", id: ids[2], score: scores[2] })
  }).then(response => response.json());
  assert.equal(rank.betterThan, 58.3);

  const staleDate = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ date: "2026-10-05", id: ids[0], score: 10 })
  });
  assert.equal(staleDate.status, 400);

  const deletion = await fetch(url, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ date: "2026-10-06", id: ids[2] })
  });
  assert.equal(deletion.status, 404);
});
