#!/usr/bin/env node
/**
 * Generates all required icon + splash PNG assets from the SVG sources.
 * Requires: npm install -D sharp
 * Usage: node scripts/gen-icons.js
 */
'use strict';

const path  = require('path');
const fs    = require('fs');

let sharp;
try { sharp = require('sharp'); } catch (_) {
  console.error('[gen-icons] sharp not installed. Run: npm install -D sharp');
  process.exit(1);
}

const ICON_SRC   = path.join(__dirname, '../assets/icons/icon.svg');
const SPLASH_SRC = path.join(__dirname, '../assets/splash/splash.svg');

/* ── Android icon sizes ─── */
const ANDROID_ICONS = [
  { dir: 'mipmap-mdpi',    size: 48  },
  { dir: 'mipmap-hdpi',    size: 72  },
  { dir: 'mipmap-xhdpi',   size: 96  },
  { dir: 'mipmap-xxhdpi',  size: 144 },
  { dir: 'mipmap-xxxhdpi', size: 192 },
];
const ANDROID_RES = path.join(__dirname, '../android/app/src/main/res');

/* ── iOS icon sizes (App Store + device) ─── */
const IOS_ICONS = [
  { name: 'Icon-20.png',        size: 20  },
  { name: 'Icon-20@2x.png',     size: 40  },
  { name: 'Icon-20@3x.png',     size: 60  },
  { name: 'Icon-29.png',        size: 29  },
  { name: 'Icon-29@2x.png',     size: 58  },
  { name: 'Icon-29@3x.png',     size: 87  },
  { name: 'Icon-40.png',        size: 40  },
  { name: 'Icon-40@2x.png',     size: 80  },
  { name: 'Icon-40@3x.png',     size: 120 },
  { name: 'Icon-60@2x.png',     size: 120 },
  { name: 'Icon-60@3x.png',     size: 180 },
  { name: 'Icon-76.png',        size: 76  },
  { name: 'Icon-76@2x.png',     size: 152 },
  { name: 'Icon-83.5@2x.png',   size: 167 },
  { name: 'ItunesArtwork.png',  size: 512 },
  { name: 'ItunesArtwork@2x.png', size: 1024 },
];
const IOS_ASSETS = path.join(__dirname, '../ios/App/App/Assets.xcassets/AppIcon.appiconset');

/* ── Android splash ─── */
const ANDROID_SPLASHES = [
  { dir: 'drawable',     w: 480,  h: 800  },
  { dir: 'drawable-land-hdpi',  w: 800,  h: 480  },
  { dir: 'drawable-land-mdpi',  w: 480,  h: 320  },
  { dir: 'drawable-land-xhdpi', w: 1280, h: 720  },
  { dir: 'drawable-port-hdpi',  w: 480,  h: 800  },
  { dir: 'drawable-port-mdpi',  w: 320,  h: 480  },
  { dir: 'drawable-port-xhdpi', w: 720,  h: 1280 },
  { dir: 'drawable-port-xxhdpi',w: 960,  h: 1600 },
  { dir: 'drawable-port-xxxhdpi',w:1280, h: 1920 },
];

async function run() {
  // Android icons
  if (fs.existsSync(ANDROID_RES)) {
    for (const { dir, size } of ANDROID_ICONS) {
      const dest = path.join(ANDROID_RES, dir);
      fs.mkdirSync(dest, { recursive: true });
      await sharp(ICON_SRC).resize(size, size).png().toFile(path.join(dest, 'ic_launcher.png'));
      await sharp(ICON_SRC).resize(size, size).png().toFile(path.join(dest, 'ic_launcher_round.png'));
      await sharp(ICON_SRC).resize(size, size).png().toFile(path.join(dest, 'ic_launcher_foreground.png'));
      console.log(`[icons] Android ${dir}: ${size}x${size}`);
    }
    // Notification icon (white, 24dp→96px)
    const notifDest = path.join(ANDROID_RES, 'drawable');
    fs.mkdirSync(notifDest, { recursive: true });
    await sharp(ICON_SRC).resize(96, 96)
      .grayscale().threshold(128)
      .png().toFile(path.join(notifDest, 'ic_stat_icon.png'));
  } else {
    console.warn('[icons] Android res dir not found — run npm run add:android first');
  }

  // iOS icons
  if (fs.existsSync(path.join(__dirname, '../ios'))) {
    fs.mkdirSync(IOS_ASSETS, { recursive: true });
    for (const { name, size } of IOS_ICONS) {
      // flatten removes alpha channel — Apple rejects transparent App Store icons
      await sharp(ICON_SRC)
        .resize(size, size)
        .flatten({ background: '#0f1623' })
        .png()
        .toFile(path.join(IOS_ASSETS, name));
      console.log(`[icons] iOS ${name}: ${size}x${size}`);
    }
    // Write Contents.json for Xcode asset catalog
    const contents = {
      images: [
        // iPhone
        { idiom:'iphone', scale:'2x', size:'20x20',   filename:'Icon-20@2x.png'    },
        { idiom:'iphone', scale:'3x', size:'20x20',   filename:'Icon-20@3x.png'    },
        { idiom:'iphone', scale:'2x', size:'29x29',   filename:'Icon-29@2x.png'    },
        { idiom:'iphone', scale:'3x', size:'29x29',   filename:'Icon-29@3x.png'    },
        { idiom:'iphone', scale:'2x', size:'40x40',   filename:'Icon-40@2x.png'    },
        { idiom:'iphone', scale:'3x', size:'40x40',   filename:'Icon-40@3x.png'    },
        { idiom:'iphone', scale:'2x', size:'60x60',   filename:'Icon-60@2x.png'    },
        { idiom:'iphone', scale:'3x', size:'60x60',   filename:'Icon-60@3x.png'    },
        // iPad
        { idiom:'ipad',   scale:'1x', size:'20x20',   filename:'Icon-20.png'       },
        { idiom:'ipad',   scale:'2x', size:'20x20',   filename:'Icon-20@2x.png'    },
        { idiom:'ipad',   scale:'1x', size:'29x29',   filename:'Icon-29.png'       },
        { idiom:'ipad',   scale:'2x', size:'29x29',   filename:'Icon-29@2x.png'    },
        { idiom:'ipad',   scale:'1x', size:'40x40',   filename:'Icon-40.png'       },
        { idiom:'ipad',   scale:'2x', size:'40x40',   filename:'Icon-40@2x.png'    },
        { idiom:'ipad',   scale:'1x', size:'76x76',   filename:'Icon-76.png'       },
        { idiom:'ipad',   scale:'2x', size:'76x76',   filename:'Icon-76@2x.png'    },
        { idiom:'ipad',   scale:'2x', size:'83.5x83.5', filename:'Icon-83.5@2x.png' },
        // App Store (1024×1024)
        { idiom:'ios-marketing', scale:'1x', size:'1024x1024', filename:'ItunesArtwork@2x.png' },
      ],
      info: { author: 'xcode', version: 1 },
    };
    fs.writeFileSync(path.join(IOS_ASSETS, 'Contents.json'), JSON.stringify(contents, null, 2));
    console.log('[icons] iOS Contents.json written');
  } else {
    console.warn('[icons] iOS dir not found — run npm run add:ios first (requires macOS)');
  }

  // Android splashes
  if (fs.existsSync(ANDROID_RES)) {
    for (const { dir, w, h } of ANDROID_SPLASHES) {
      const dest = path.join(ANDROID_RES, dir);
      fs.mkdirSync(dest, { recursive: true });
      await sharp(SPLASH_SRC).resize(w, h, { fit: 'cover', position: 'center' }).png()
        .toFile(path.join(dest, 'splash.png'));
      console.log(`[splash] Android ${dir}: ${w}x${h}`);
    }
  }

  console.log('\n[gen-icons] Done.');
}

run().catch(err => { console.error(err); process.exit(1); });
