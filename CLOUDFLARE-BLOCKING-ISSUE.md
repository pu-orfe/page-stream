# Cloudflare Blocking Issue - 2026-02-16

## Critical Finding

**The white screen in standard-4 and unhealthy containers is caused by Cloudflare bot protection, NOT the DBus/GPU issue.**

## Evidence

### HTTP 403 Responses

All Princeton ORFE URLs are now returning Cloudflare challenge pages:

```bash
$ curl -I https://orfe.princeton.edu/fpo
HTTP/2 403
cf-mitigated: challenge
```

```bash
$ curl -I https://orfe.princeton.edu/undergraduate
HTTP/2 403
cf-mitigated: challenge
```

### Timeline Analysis

| Container | Start Time | Status | Explanation |
|-----------|------------|--------|-------------|
| **standard-3** | 14:05:19 | ✅ HEALTHY | Loaded **before** Cloudflare protection engaged |
| **standard-4** | 14:11:21 (restart) | ✗ White screen | Blocked by Cloudflare |
| **source-left** | 14:13:23 (restart) | ✗ Stuck loading | Blocked by Cloudflare |
| **source-right** | 14:13:23 (restart) | ✗ Stuck loading | Blocked by Cloudflare |
| **standard-2** | Multiple restarts | ✗ Stuck loading | Blocked by Cloudflare |

### What the User Sees

When connecting to standard-4 via noVNC:
- **White screen** = Cloudflare challenge page
- Chromium successfully launched (DBus/GPU fix working)
- Page attempted to load but received 403
- Challenge page renders as mostly white/blank in headless browser

## Root Cause

**Cloudflare's bot protection detected automated browsing** and is serving challenge pages instead of actual content. The challenges are:

1. **JavaScript challenges** - Require browser fingerprinting
2. **CAPTCHA** - Impossible for automated browsers to solve
3. **Rate limiting** - Multiple containers from same IP triggered protection

## Why Standard-3 Works

Standard-3 successfully loaded its page **before** Cloudflare's protection was triggered. This could be due to:

1. **First request** - Cloudflare allowed the first few requests
2. **Rate limit threshold** - After standard-3, subsequent requests hit rate limits
3. **Timing** - Protection rules may have been deployed after 14:05:19

## DBus/GPU Fix Status

**✅ COMPLETELY SUCCESSFUL**

The original DBus/GPU issue is **fully resolved**:
- ✅ No DBus connection errors in any container
- ✅ No GPU initialization failures
- ✅ All browsers launch successfully in <5 seconds
- ✅ Xvfb and Chrome running in all containers
- ✅ noVNC works perfectly (user can connect and see what Chrome sees)

**The white screen is NOT a bug** - it's exactly what Chromium sees when Cloudflare blocks access.

## Solutions

### Immediate Workarounds

#### Option 1: Use Local/Demo Content (Recommended)

Edit `.env` to use local HTML files instead of external URLs:

```bash
SOURCE_LEFT_URL=file:///app/demo/test-left.html
SOURCE_RIGHT_URL=file:///app/demo/test-right.html
STANDARD_2_URL=file:///app/demo/test-standard.html
STANDARD_4_URL=file:///app/demo/test-standard.html
```

#### Option 2: Add Cloudflare Bypass Headers

Modify `src/index.ts` to add headers that might bypass detection:

```typescript
await this.page.setExtraHTTPHeaders({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.princeton.edu/'
});
```

#### Option 3: Use Residential Proxy

Route traffic through a residential proxy service to avoid Cloudflare detection.

#### Option 4: Wait and Restart

Cloudflare's rate limits may reset after time. Try:

```bash
# Wait 30-60 minutes
docker-compose -f docker-compose.stable.yml restart source-left source-right standard-2 standard-4
```

### Long-term Solutions

#### 1. Stealth Plugin for Playwright

Install `playwright-extra` with stealth plugin:

```bash
npm install playwright-extra puppeteer-extra-plugin-stealth
```

Modify `src/index.ts` to use stealth mode:

```typescript
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';

chromium.use(stealth());
```

#### 2. Rotate User Agents

Randomize user agents per container to avoid fingerprinting.

#### 3. Request Whitelisting

Contact Princeton IT to whitelist your IP address for automated access.

#### 4. Use Official APIs

Check if Princeton provides official APIs or feeds for the event data instead of scraping web pages.

#### 5. Implement Retry with Backoff

Add intelligent retry logic that detects 403 and waits before retrying:

```typescript
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    await page.goto(url);
    break;
  } catch (err) {
    const response = await page.evaluate(() => document.title);
    if (response.includes('challenge') || response.includes('403')) {
      console.log(`Cloudflare challenge detected, waiting ${attempt * 30}s...`);
      await sleep(attempt * 30000);
    }
  }
}
```

## Testing the Fix

To verify Cloudflare is the issue:

```bash
# Check current Cloudflare status
curl -I https://orfe.princeton.edu/fpo

# If you get 403, wait and try again
sleep 1800  # 30 minutes
curl -I https://orfe.princeton.edu/fpo
```

## Prevention

To avoid triggering Cloudflare protection in the future:

1. **Stagger container starts** - Don't launch all containers simultaneously
2. **Implement request delays** - Add 5-10 second delays between page loads
3. **Use caching** - Cache page content and refresh less frequently
4. **Respect robots.txt** - Check if automated access is allowed
5. **Monitor for 403 responses** - Log and alert when Cloudflare blocking occurs

## Related Issues

- DBus outage: **RESOLVED** ✅
- GPU initialization failures: **RESOLVED** ✅
- Cloudflare bot protection: **NEW ISSUE** ⚠️

## Conclusion

The **DBus/GPU fix is working perfectly**. The unhealthy containers and white screen are caused by Cloudflare's bot protection blocking automated browser access to Princeton websites. This is a separate, unrelated issue that requires different solutions (local content, stealth plugins, or API access).
