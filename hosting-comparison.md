# Personal AI Assistant Hosting: Cost & Performance Comparison

**Use case**: Node.js Telegram bot (~100MB RAM), always-on, calling Claude API
**Date**: March 2026

---

## Cost & Specs Comparison Table

| Platform | Monthly Cost | CPU | RAM | Storage | Bandwidth | Always-On? |
|----------|-------------|-----|-----|---------|-----------|------------|
| **Raspberry Pi 5** (at home) | ~Rs.30-55/mo electricity | 4-core ARM Cortex-A76 | 4 GB | SD card / USB SSD | Home ISP | Yes |
| **AWS EC2 t4g.nano** | ~$4.50-5.50 (instance + 8GB EBS + IPv4) | 2 vCPU (ARM, burstable) | 512 MB | 8 GB EBS ($0.80/mo) | 100 GB free then $0.09/GB | Yes |
| **AWS Lightsail** | $3.50 (IPv6) / $5 (IPv4) | 1 vCPU | 512 MB | 20 GB SSD | 1 TB included | Yes |
| **GCP e2-micro** (free tier) | $0 (free tier) | 2 vCPU (burstable, 0.25 shared) | 1 GB | 30 GB standard (free) | 1 GB egress free, then $0.12/GB | Yes |
| **GCP Cloud Run** (serverless) | ~$0-3/mo (low traffic) | On-demand | On-demand | None (stateless) | Pay per request | Scales to 0 |
| **Hetzner CAX11** (ARM) | EUR 4.49/mo (from Apr 2026) | 2 vCPU ARM (shared) | 4 GB | 40 GB SSD | 20 TB included | Yes |
| **Oracle Cloud** (free tier) | $0 (free forever) | Up to 4 OCPU ARM (Ampere A1) | Up to 24 GB | 200 GB block | 10 TB/mo | Yes |
| **Fly.io** | ~$2.25-3/mo | shared-cpu-1x | 256 MB | 1 GB root | Outbound: ~$0.02/GB | Yes |
| **Railway** | ~$5-7/mo | Usage-based | Usage-based | 1 GB | Included | Yes |
| **Render** (Starter) | $7/mo | 0.5 CPU | 512 MB | Ephemeral | 100 GB/mo | Yes |
| **DigitalOcean** | $4/mo | 1 vCPU | 512 MB | 10 GB SSD | 500 GB | Yes |

---

## Detailed Analysis Per Option

### 1. Raspberry Pi 5 at Home

**Monthly cost breakdown:**
- Electricity: Pi 5 draws ~4W idle, ~9W under load. For a light bot, assume ~5W average.
  - 5W x 24h x 30 days = 3.6 kWh/month
  - India residential rate: ~Rs.6-8/kWh (varies by state)
  - Cost: **Rs.22-29/month (~$0.26-0.35/month)**
  - Add USB SSD power (~1W): total ~Rs.30-40/month
- Hardware (already owned): $0 recurring. SD card replacement every 1-2 years (~$15), or use USB SSD ($25 one-time).
- Tailscale: free tier is sufficient.

**Latency:**
- To Claude API (us-east/us-west): 150-250ms from India (international hop)
- To Telegram API (global CDN): 50-150ms from India
- Home network adds negligible latency vs cloud

**Uptime/Reliability:**
- **Weakest link is power and ISP.** India experiences power outages (varies by city); a UPS (~Rs.2000-4000) can help.
- SD card corruption is a real risk. Use USB SSD boot + ext4 journaling.
- ISP outages: Tailscale helps with reconnection but can't solve full outages.
- No SLA. Realistic uptime: 95-99% depending on location and infrastructure.

**Ease of deployment:**
- SSH in, `git pull`, `pm2 start`. Very simple.
- You manage OS updates, Node.js versions, and security patches yourself.

**Scaling:**
- 4GB RAM and quad-core A76 is overkill for this workload. Handles bursts easily.
- Limited by ISP upload speed for any outbound data.

**Gotchas:**
- Dynamic IP (most Indian ISPs) -- Tailscale solves this.
- Port forwarding for webhooks requires DDNS or Tailscale Funnel.
- SD card wear (use SSD or zram to minimize writes).

---

### 2. AWS EC2 t4g.nano

**Monthly cost breakdown:**
- Instance: $3.07/mo (us-east-1, on-demand)
- EBS 8GB gp3: ~$0.64/mo
- Public IPv4: $3.60/mo (since Feb 2024, AWS charges for IPv4!)
- **Total: ~$7.31/mo** with IPv4, or ~$3.71/mo with IPv6-only

**Latency:**
- Deploy in ap-south-1 (Mumbai): <20ms to Indian users, ~150ms to Claude API (US)
- Deploy in us-east-1: ~150ms from India, <10ms to Claude API

**Uptime:** 99.99% SLA. Excellent.

**Ease of deployment:** Moderate. EC2 requires security groups, key pairs, EBS management. Use cloud-init or SSM for setup.

**Scaling:** t4g.nano is burstable (2 vCPU but only 5% baseline). Sustained CPU bursts will exhaust credits. Fine for a bot with occasional spikes.

**Gotchas:**
- The IPv4 charge ($3.60/mo) nearly doubles the cost. Use IPv6-only if possible (but Telegram webhook needs IPv4).
- 512MB RAM is tight -- Node.js + your bot will use ~150-200MB, leaving little headroom.
- EBS and snapshots cost extra.

---

### 3. AWS Lightsail

**Monthly cost: $3.50 (IPv6) / $5 (IPv4)**

- All-inclusive: instance, SSD, transfer, static IP bundled.
- 512MB RAM, 1 vCPU, 20GB SSD, 1TB transfer.

**vs EC2:** Simpler, cheaper (IPv4 included in the $5 plan), but less flexible. No autoscaling, fewer instance types.

**Best AWS option for this use case.** Predictable billing, no surprise charges.

---

### 4. AWS Lambda (Serverless)

**Monthly cost: $0-1/mo** (within free tier for low volume)
- Free tier: 1M requests + 400K GB-seconds/month
- A Telegram bot with ~100-500 messages/day easily fits in free tier

**How it works:** Telegram sends webhook to API Gateway -> triggers Lambda -> calls Claude API -> responds.

**Cold start:** Node.js Lambda cold start is 200-500ms. With provisioned concurrency, ~$0/mo extra for 1 instance, but removes free tier benefit.

**Gotchas:**
- Stateless: no in-memory conversation context between invocations. Must use DynamoDB/S3 for state.
- API Gateway cost: $3.50 per million requests (negligible at low volume).
- 15-minute max execution time: fine for Claude API calls, but long-running tasks need redesign.
- Cold starts mean first message after idle takes 1-2 seconds extra.

---

### 5. Google Cloud e2-micro (Free Tier)

**Monthly cost: $0** (Always Free tier, truly free forever)
- 1 e2-micro VM (2 vCPU shared, 0.25 vCPU baseline, 1GB RAM)
- 30GB standard persistent disk (free)
- 1GB egress/mo free (then $0.12/GB -- this is the hidden cost)
- Regions: us-west1, us-east1, us-central1 only

**Latency:**
- From US to Claude API: excellent (<10ms)
- From US to user in India: 150-250ms (acceptable for a chat bot)

**Uptime:** 99.95% SLA. Very reliable.

**Ease of deployment:** Moderate. GCP console is complex. Use `gcloud` CLI or Terraform.

**Scaling:** e2-micro has only 0.25 vCPU baseline with bursting. Fine for a bot, but CPU-intensive morning briefing processing could be sluggish.

**Gotchas:**
- **Egress bandwidth cap**: 1GB free is very tight. Each Claude API response could be 1-5KB; 1000 messages/day = ~5MB/day = ~150MB/mo. Should be fine, but monitor it.
- **Preemption risk**: Not preemptible by default, but Google reserves right to terminate if you exceed CPU bursting limits excessively.
- US-only regions for free tier.
- Must keep project active (use it periodically) or Google may reclaim resources.

---

### 6. Google Cloud Run (Serverless)

**Monthly cost: ~$0-3/mo** (low traffic)
- Free tier: 2M requests, 360K vCPU-seconds, 180K GiB-seconds/month
- Pay only when processing requests (scales to 0)

**Cold start:** Container startup is 1-5 seconds for Node.js (heavier than Lambda). Setting min-instances=1 eliminates cold starts but costs ~$10-12/mo.

**Best for:** Webhook-driven bot with very low message volume. Not ideal if you want instant responses -- cold starts of 2-5 seconds feel laggy in a chat context.

---

### 7. Hetzner CAX11 (ARM)

**Monthly cost: EUR 4.49/mo (~$4.85)** from April 2026
- 2 shared ARM vCPU (Ampere Altra), 4GB RAM, 40GB SSD, 20TB traffic
- IPv4 + IPv6 included, DDoS protection included

**Latency:**
- EU-only (Germany/Finland). ~100ms to Claude API (US), ~120-180ms to India.
- Not ideal for India-based user, but acceptable for a bot.

**Uptime:** Very reliable. Hetzner has strong infrastructure, though no formal SLA on cloud VPS.

**Ease of deployment:** Simple. SSH access, standard Linux VPS. Very developer-friendly.

**Scaling:** 4GB RAM and 2 vCPU is generous for this workload. No burst limitations.

**Gotchas:**
- EU-only (no Asia/US regions for ARM).
- Price increase taking effect April 1, 2026 (30-40% across the board).
- No managed services -- you handle everything.

**Verdict: Best price-to-specs ratio among paid options.**

---

### 8. Oracle Cloud Free Tier (ARM)

**Monthly cost: $0** (Always Free)
- Up to 4 OCPU + 24GB RAM (Ampere A1 Flex) -- absurdly generous
- 200GB block storage, 10TB/mo egress
- Can split across up to 4 instances

**Latency:**
- Available in Mumbai (ap-mumbai-1): excellent for India-based user
- ~150ms to Claude API (US) from Mumbai

**Uptime:** Generally good, but...

**Gotchas -- THIS IS THE BIG ONE:**
- **Capacity issues**: ARM instances are extremely hard to provision. "Out of capacity" errors are common. You may need to run scripts to repeatedly try provisioning until a slot opens (can take days/weeks).
- **Oracle may reclaim idle instances**: Oracle's policy states they can reclaim Always Free instances that are "idle" (low CPU usage). A bot that mostly waits for messages could be flagged.
- **Account termination risk**: Reports of Oracle terminating free-tier-only accounts exist. Adding a payment method and running a small paid resource (~$1/mo) reportedly reduces this risk.
- **Support**: No support on free tier. If something breaks, you're on your own.
- **Not reliable as sole hosting.** Great as a free secondary/backup.

---

### 9. Fly.io

**Monthly cost: ~$2.25-3.00/mo**
- shared-cpu-1x (1 shared vCPU): ~$1.94/mo
- 256MB RAM: ~$0.31/mo
- 1GB root volume: included
- Pay-as-you-go billing

**Latency:**
- Regions include Chennai (MAA) -- excellent for India.
- Edge deployment means low latency globally.

**Uptime:** Generally good. Some users report occasional issues with Fly's infrastructure.

**Ease of deployment:** Excellent. `fly launch`, `fly deploy`. Dockerfile-based. Very smooth DX.

**Scaling:** Auto-stop/start machines to save money. Can scale to multiple regions.

**Gotchas:**
- 256MB RAM is tight. Budget 512MB (~$0.62/mo extra) to be safe.
- Fly.io has had reliability incidents. Not as battle-tested as AWS/GCP.
- Persistent storage (Volumes) costs extra: $0.15/GB/mo.

---

### 10. Railway

**Monthly cost: ~$5-7/mo**
- $5/mo subscription fee + usage-based compute
- A low-traffic bot might cost $5-7 total

**Ease of deployment:** Best-in-class. Connect GitHub repo, deploy. Zero config.

**Gotchas:**
- The $5/mo base fee applies even if usage is minimal.
- Less control over infrastructure.
- Resource limits on lower tiers.

---

### 11. Render (Starter)

**Monthly cost: $7/mo**
- 0.5 CPU, 512MB RAM, always-on

**Ease of deployment:** Very easy. Git push to deploy.

**Gotchas:**
- Free tier spins down after inactivity (cold starts).
- Paid tier at $7/mo is pricier than alternatives for what you get.
- 100GB bandwidth cap on Starter.

---

### 12. DigitalOcean

**Monthly cost: $4/mo**
- 1 vCPU, 512MB RAM, 10GB SSD, 500GB transfer

**Latency:** Bangalore datacenter available (BLR1) -- excellent for India.

**Uptime:** 99.99% SLA. Very reliable.

**Ease of deployment:** Straightforward. Good UI, good docs, one-click apps.

**Gotchas:**
- 512MB is adequate but not generous.
- No free tier for VMs.

---

## Ranking by Monthly Cost

| Rank | Platform | Monthly Cost | Notes |
|------|----------|-------------|-------|
| 1 | **Oracle Cloud Free** | $0 | Hard to provision, reclamation risk |
| 2 | **GCP e2-micro Free** | $0 | US-only, 1GB egress limit |
| 3 | **Raspberry Pi 5** | ~$0.30 | Electricity only; reliability depends on power/ISP |
| 4 | **AWS Lambda** (serverless) | $0-1 | Cold starts, stateless, free tier |
| 5 | **GCP Cloud Run** | $0-3 | Cold starts 2-5s, webhook-driven |
| 6 | **Fly.io** | ~$2.25-3 | Tight on 256MB, use 512MB for ~$3 |
| 7 | **AWS Lightsail** (IPv6) | $3.50 | Simple, predictable |
| 8 | **DigitalOcean** | $4 | Solid, Bangalore DC available |
| 9 | **Hetzner CAX11** | ~$4.85 | Best specs/dollar, EU-only |
| 10 | **AWS Lightsail** (IPv4) | $5 | With public IPv4 |
| 11 | **Railway** | $5-7 | Easiest deploy, base fee |
| 12 | **Render** | $7 | Overpriced for specs |
| 13 | **AWS EC2 t4g.nano** | ~$7.31 | IPv4 charge kills it |

---

## Raspberry Pi 5: Power Cost Calculation (India)

```
Power draw (idle + light load):  ~5 watts
Hours per day:                   24
Days per month:                  30

Monthly consumption:  5W x 24h x 30d = 3,600 Wh = 3.6 kWh

India electricity rates (2026, residential):
  Low  (subsidized/low slab):  Rs.3-4/kWh  -> Rs.11-14/month  (~$0.13-0.17)
  Mid  (typical urban):        Rs.6-8/kWh  -> Rs.22-29/month  (~$0.26-0.35)
  High (high-consumption slab): Rs.8-10/kWh -> Rs.29-36/month (~$0.35-0.43)

Annual cost: Rs.130-430/year ($1.50-5.00/year)
```

This is essentially free compared to any cloud option.

---

## Hybrid Approach: Pi at Home + Cloud Backup

**Architecture:**
```
Primary:   Raspberry Pi 5 at home (via Tailscale)
Failover:  Oracle Cloud Free / GCP e2-micro Free

Health check: Cloud instance pings Pi every 60s
If Pi is unreachable for 3 minutes:
  -> Cloud instance activates and takes over Telegram webhook
  -> Webhook URL updated via Telegram Bot API setWebhook()
When Pi comes back:
  -> Webhook switches back to Pi
```

**Implementation considerations:**
- Both instances share state via SQLite replicated to cloud storage (S3/GCS), or use a lightweight managed DB.
- Tailscale Funnel can expose the Pi's bot endpoint without port forwarding.
- The failover cloud instance costs $0 if using Oracle/GCP free tier.
- A simple cron job or uptime monitor (UptimeRobot free tier) can trigger the failover.

**This is the recommended approach** -- you get the cost benefits of the Pi with cloud reliability as a safety net.

---

## Serverless Viability: Lambda/Cloud Run as Telegram Bot

**How it works:**
1. Set Telegram webhook to Lambda/Cloud Run URL
2. Each message triggers a function invocation
3. Function calls Claude API, returns response
4. Function terminates

**Pros:**
- Near-zero cost at low volumes (free tier covers hundreds of messages/day)
- No server management
- Auto-scales to any burst

**Cons:**
- **Cold starts**: Lambda (Node.js) = 200-500ms; Cloud Run = 1-5 seconds. User notices a delay on first message after idle.
- **Statelessness**: No in-memory context. Every invocation starts fresh. Must persist conversation state to a database (DynamoDB, Firestore), adding latency and complexity.
- **Timeout risk**: If Claude API takes >10s to respond (complex queries), Lambda handles it fine (up to 15 min), but Cloud Run default timeout is 300s.
- **No background processing**: Can't run scheduled tasks (morning briefing) without a separate scheduler (EventBridge/Cloud Scheduler).
- **Complexity**: More moving parts (API Gateway + Lambda + DynamoDB vs. one Node.js process).

**Verdict:** Viable for a simple bot with low volume. Not ideal for a "personal assistant" that needs persistent state, scheduled tasks, and instant responsiveness. The always-on VM approach (Pi or cheap VPS) is simpler and more capable.

---

## Recommendations

### Best Overall: Raspberry Pi 5 + Free Cloud Failover
- **Cost**: ~$0.30/mo electricity
- **Why**: You already own it, it's overpowered for the task, and Tailscale makes networking easy. Add Oracle or GCP free tier as failover for the 1-5% of time your power/ISP is down.

### Best Pure Cloud (Free): GCP e2-micro
- **Cost**: $0/mo
- **Why**: Truly free forever, reliable, sufficient specs. The 1GB egress limit is the only concern, but a text-based bot should stay well under it.

### Best Pure Cloud (Paid): Hetzner CAX11
- **Cost**: ~$4.85/mo
- **Why**: 4GB RAM and 2 ARM vCPUs at under $5/mo is unbeatable on specs. EU-only location is the tradeoff.

### Best for India Latency (Paid): DigitalOcean (Bangalore)
- **Cost**: $4/mo
- **Why**: BLR1 datacenter gives lowest latency to Indian users and reasonable latency to Claude API.

### Avoid:
- **AWS EC2 t4g.nano**: IPv4 surcharge makes it overpriced.
- **Render**: Overpriced for what you get.
- **Oracle Free Tier as sole host**: Too unreliable (provisioning issues, reclamation risk).
