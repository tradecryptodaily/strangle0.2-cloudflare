// DEPRECATED — positions now come from positions.js in the repo (no API keys
// needed). This endpoint is kept only so old clients get a clear message.
module.exports = (req, res) => {
  res.status(410).json({ error: "positions moved to positions.js (repo config)" });
};
