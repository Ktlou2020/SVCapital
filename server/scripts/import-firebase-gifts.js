/**
 * One-off script: import Firebase gift records into the gifts table.
 * Run: DATABASE_URL=<url> node server/scripts/import-firebase-gifts.js <path-to-json>
 *
 * Firebase status mapping: SUCCESS → claimed, EXPIRED → expired
 * Sender is identified by userAccountNumber (= investors.id PK).
 * Recipient is identified by email; recipient_id set if a matching investor exists.
 */
'use strict';

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  ssl: { rejectUnauthorized: false },
});

const PRODUCT_ID_MAP = {
  'gSjiuqRg3E8IEO2hwfmu': 'Cattle Investment',
  '8r3TlnGkizidu1JCgbDp': 'SMME Investment',
  'xKQkwQMa0Hnj0dAmGsWH': 'Solar Investment',
  'BjrELvLGvQzTSDt9ztGK': 'Solar Investment',
  'SfpCxgJjP6i5GUz1JWYp': 'Solar Investment',
  'lwKM2GFyCXNd88l1nCAK': 'iLobola Investment',
  'Q3R5RN21GWJ4lGCtI72R': '12J Cattle Investment',
  '0J1g67Ln99nMOct6vnqS': 'Delivery Bike Investment',
};

function resolveProduct(investment) {
  if (!investment) return null;
  const parts = investment.split('/');
  const prodId = parts[parts.length - 1];
  return PRODUCT_ID_MAP[prodId] || null;
}

async function ensureGiftCardUrlColumn(client) {
  await client.query(`
    DO $$ BEGIN
      ALTER TABLE gifts ADD COLUMN gift_card_url TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
  `);
  await client.query(`
    DO $$ BEGIN
      ALTER TABLE gifts ADD COLUMN product_type TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
  `);
  await client.query(`
    DO $$ BEGIN
      ALTER TABLE gifts ADD COLUMN firebase_id TEXT UNIQUE;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
  `);
}

async function run() {
  const jsonFile = process.argv[2];
  if (!jsonFile) {
    console.error('Usage: node import-firebase-gifts.js <path-to-gifts.json>');
    process.exit(1);
  }

  const raw = fs.readFileSync(path.resolve(jsonFile), 'utf8');
  const gifts = JSON.parse(raw);
  console.log(`\n📦 Loaded ${gifts.length} gift records from JSON\n`);

  const client = await pool.connect();
  try {
    await ensureGiftCardUrlColumn(client);
    console.log('✓ Schema columns ensured (gift_card_url, product_type, firebase_id)\n');

    let inserted = 0, skipped = 0, errors = 0;

    for (const g of gifts) {
      const firebaseId = g._id;

      // Check if already imported
      const { rows: exists } = await client.query(
        `SELECT id FROM gifts WHERE firebase_id = $1`, [firebaseId]
      );
      if (exists.length) {
        console.log(`  ⏭  ${firebaseId} already imported — skipping`);
        skipped++;
        continue;
      }

      // Resolve sender_id from userAccountNumber (= investors.id)
      const senderAccountNum = g.userAccountNumber?.trim();
      let senderId = null;
      if (senderAccountNum) {
        const { rows } = await client.query(
          `SELECT id FROM investors WHERE id = $1`, [senderAccountNum]
        );
        senderId = rows[0]?.id || null;
        if (!senderId) {
          console.log(`  ⚠  ${firebaseId}: sender account "${senderAccountNum}" not found in investors`);
        }
      }

      // Resolve recipient_id from email
      const recipientEmail = (g.email || '').trim().toLowerCase();
      let recipientId = null;
      if (recipientEmail) {
        const { rows } = await client.query(
          `SELECT id FROM investors WHERE LOWER(email) = $1`, [recipientEmail]
        );
        recipientId = rows[0]?.id || null;
      }

      if (!recipientEmail) {
        console.log(`  ✗  ${firebaseId}: no recipient email — skipping`);
        errors++;
        continue;
      }

      const statusMap = { SUCCESS: 'claimed', EXPIRED: 'expired' };
      const status = statusMap[g.status] || 'claimed';
      const claimedAt = status === 'claimed' && g.dateUpdated ? new Date(g.dateUpdated) : null;
      const sentAt    = g.date ? new Date(g.date) : new Date();
      const expiresAt = status === 'claimed' ? claimedAt : sentAt;
      const giftId    = `GIFT-FB-${firebaseId}`;
      const claimToken = `fb-${firebaseId}-${Buffer.from(firebaseId).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`;
      const giftCardUrl = g.giftCardURL && g.giftCardURL !== '""' && g.giftCardURL.startsWith('http') ? g.giftCardURL : null;
      const productType = resolveProduct(g.investment);
      const recipientName = (g.name || '').trim() || null;
      const message = (g.message || '').trim() || null;

      try {
        await client.query(`
          INSERT INTO gifts (
            id, sender_id, recipient_id, recipient_email, recipient_name,
            amount, message, status, claim_token,
            sent_at, claimed_at, expires_at, created_at,
            gift_card_url, product_type, firebase_id
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
          ON CONFLICT (firebase_id) DO NOTHING
        `, [
          giftId, senderId, recipientId, recipientEmail, recipientName,
          g.amount, message, status, claimToken,
          sentAt, claimedAt, expiresAt, sentAt,
          giftCardUrl, productType, firebaseId,
        ]);

        const senderLabel = senderAccountNum || '(unknown)';
        console.log(`  ✓  ${firebaseId}: ${g.amount} → ${recipientEmail} [${status}] from ${senderLabel}`);
        inserted++;
      } catch (err) {
        console.error(`  ✗  ${firebaseId}: INSERT error: ${err.message}`);
        errors++;
      }
    }

    console.log(`\n✅ Done. Inserted: ${inserted}  Skipped: ${skipped}  Errors: ${errors}`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
