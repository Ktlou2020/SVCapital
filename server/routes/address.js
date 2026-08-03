'use strict';

const router = require('express').Router();
const https  = require('https');

/* Public endpoint — geocoding only, no sensitive data */
router.get('/autocomplete', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 3) return res.json({ results: [] });

  const apiKey = process.env.GEOAPIFY_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Address service not configured' });

  const params = new URLSearchParams({
    text: q,
    'filter[countrycode]': 'za',
    format: 'json',
    apiKey,
    limit: 6,
  });

  const hReq = https.get(
    `https://api.geoapify.com/v1/geocode/autocomplete?${params}`,
    upRes => {
      let data = '';
      upRes.on('data', c => data += c);
      upRes.on('end', () => {
        try { res.json(JSON.parse(data)); }
        catch { res.status(502).json({ error: 'Address service error' }); }
      });
    }
  );
  hReq.on('error', () => res.status(502).json({ error: 'Address service unavailable' }));
});

module.exports = router;
