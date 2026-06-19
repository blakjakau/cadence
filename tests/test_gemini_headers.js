import fs from 'fs';
const apiKey = JSON.parse(fs.readFileSync('/home/jason/.gemini/antigravity/workspace/settings.json', 'utf8')).geminiConfig.apiKey;
const requestBody = {
  contents: [{ role: "user", parts: [{ text: "hi" }] }]
};
fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(requestBody)
}).then(res => {
  console.log("Status:", res.status);
  console.log("Headers:");
  res.headers.forEach((value, name) => console.log(name, ":", value));
}).catch(console.error);
