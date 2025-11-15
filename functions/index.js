/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const {setGlobalOptions} = require("firebase-functions");
const {onRequest} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const {initializeApp} = require("firebase-admin/app");
const {getAuth} = require("firebase-admin/auth");
const {getFirestore} = require("firebase-admin/firestore");

// For cost control, you can set the maximum number of containers that can be
// running at the same time. This helps mitigate the impact of unexpected
// traffic spikes by instead downgrading performance. This limit is a
// per-function limit. You can override the limit for each function using the
// `maxInstances` option in the function's options, e.g.
// `onRequest({ maxInstances: 5 }, (req, res) => { ... })`.
// NOTE: setGlobalOptions does not apply to functions using the v1 API. V1
// functions should each use functions.runWith({ maxInstances: 10 }) instead.
// In the v1 API, each function can only serve one request per container, so
// this will be the maximum concurrent request count.
setGlobalOptions({maxInstances: 10, region: "europe-southwest1"});

// Initialize Admin SDK
initializeApp();

const isEmulator = process.env.FUNCTIONS_EMULATOR === "true" ||
  !!process.env.FIREBASE_AUTH_EMULATOR_HOST ||
  !!process.env.FIRESTORE_EMULATOR_HOST;

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

exports.helloWorld = onRequest((request, response) => {
  logger.info("Hello logs!", {structuredData: true});
  response.send("Hello from Firebase!");
});

function extractIdToken(request) {
  const authHeader = request.headers.authorization || request.headers.Authorization || "";
  const match = authHeader.match(/^Bearer (.+)$/i);
  if (!match) {
    throw new Error("Missing or invalid Authorization header");
  }
  return match[1];
}

function mockSummarize(text) {
  const t = String(text || "").trim().replace(/\s+/g, " ");
  if (!t) return "(Nota vacía)";
  const firstSentence = t.split(/(?<=[.!?])\s+/)[0] || t.slice(0, 240);
  const clipped = firstSentence.length > 240 ? firstSentence.slice(0, 240) + "…" : firstSentence;
  return `Resumen: ${clipped}`;
}

exports.getUserNotes = onRequest(async (request, response) => {
  logger.info("Get user notes function triggered", {structuredData: true});
  try {
    const idToken = extractIdToken(request);
    const decoded = await getAuth().verifyIdToken(idToken);
    const uid = decoded.uid;
    const db = getFirestore();
    const usersCol = db.collection("users");
    const notesCol = usersCol.doc(uid).collection("notes");
    const snap = await notesCol.get();
    const notes = snap.docs.map((d) => ({id: d.id, ...d.data()}));
    response.status(200).json({notes});
  } catch (err) {
    logger.error("getUserNotes error", {error: String(err)});
    response.status(401).send("Unauthorized");
  }
});

exports.summarizeNote = onRequest({ secrets: ["OPENAI_API_KEY"] }, async (request, response) => {
  logger.info("summarizeNote triggered", {structuredData: true});
  const noteId = (request.query.id || (request.body && request.body.id) || "").trim();
  if (!noteId) {
    response.status(400).json({error: "Missing note id"});
    return;
  }
  let uid;
  try {
    const idToken = extractIdToken(request);
    const decoded = await getAuth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (err) {
    logger.error("Auth failure summarizeNote", {error: String(err)});
    response.status(401).json({error: "Unauthorized"});
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY || process.env.openai_key || "";

  try {
    const db = getFirestore();
    const noteRef = db.collection("users").doc(uid).collection("notes").doc(noteId);
    const noteSnap = await noteRef.get();
    if (!noteSnap.exists) {
      response.status(404).json({error: "Note not found"});
      return;
    }
    const data = noteSnap.data() || {};
    const text = data.content || data.text || data.body || "";
    if (!text) {
      response.status(400).json({error: "Note has no text field (expected content/text/body)"});
      return;
    }

    if (process.env.USE_MOCK_OPENAI === "1" || (isEmulator && !apiKey)) {
      const summary = mockSummarize(text);
      response.status(200).json({id: noteId, summary, mocked: true});
      return;
    }

    if (!apiKey) {
      response.status(500).json({error: "OpenAI API key not configured"});
      return;
    }

    const prompt = `Summarize the following note in one sentence without adding new info. Note: "${text}"`;
    const openAiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {role: "system", content: "Agent that summarizes user notes."},
          {role: "user", content: prompt}
        ],
        temperature: 0.3,
        max_tokens: 60
      })
    });

    if (!openAiResp.ok) {
      const errText = await openAiResp.text();
      logger.error("OpenAI API error", {status: openAiResp.status, body: errText});
      response.status(502).json({error: "Failed to summarize", details: errText});
      return;
    }
    const aiJson = await openAiResp.json();
    const summary = aiJson.choices?.[0]?.message?.content?.trim() || "(No summary)";

    response.status(200).json({id: noteId, summary});
  } catch (err) {
    logger.error("summarizeNote failure", {error: String(err)});
    response.status(500).json({error: "Internal error"});
  }
});
