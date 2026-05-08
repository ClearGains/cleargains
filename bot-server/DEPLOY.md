# Oracle Cloud Deployment Guide

## 1. Create Oracle VM (if not done)
- Sign in to cloud.oracle.com
- Compute → Instances → Create Instance
- Shape: VM.Standard.A1.Flex (Always Free — ARM) or VM.Standard.E2.1.Micro (Always Free — AMD)
- OS: Ubuntu 22.04 or 24.04
- Add your SSH key
- Note the public IP address
- In the VCN Security List: add Ingress rule for TCP port 3001 (source 0.0.0.0/0)
- Also allow port 3001 in the VM's OS firewall: `sudo ufw allow 3001`

## 2. SSH into the VM
```bash
ssh ubuntu@<YOUR_VM_IP>
```

## 3. Install Node.js 20 + PM2
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2
```

## 4. Clone the repo
```bash
git clone https://github.com/ClearGains/cleargains.git nexustrade
cd nexustrade/bot-server
```

## 5. Set environment variables
```bash
nano .env
```
Paste and fill in:
```
BOT_SECRET=pick-a-long-random-string-here
IG_API_KEY=your-ig-api-key
IG_USERNAME=your-ig-demo-username
IG_PASSWORD=your-ig-demo-password
IG_ENV=demo
PORT=3001
```
Save with Ctrl+X, Y, Enter.

Load them into the shell:
```bash
export $(grep -v '^#' .env | xargs)
```

## 6. Install deps and build
```bash
npm install
npm run build
```

## 7. Start with PM2
```bash
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup   # follow the printed command to auto-start on reboot
```

## 8. Verify it's running
```bash
pm2 status
curl http://localhost:3001/health
```
Should return: `{"ok":true,"ts":"...","running":false}`

## 9. Add env vars to Vercel
In Vercel dashboard → Settings → Environment Variables:
- `BOT_SERVER_URL` = `http://<YOUR_VM_IP>:3001`
- `BOT_SECRET` = the same secret you put in .env on the VM

## 10. Redeploy Vercel
Push a commit or trigger a redeploy so Vercel picks up the new env vars.

## Useful PM2 commands
```bash
pm2 logs nexustrade-bot      # live log stream
pm2 restart nexustrade-bot   # restart after code change
pm2 stop nexustrade-bot      # stop the bot
```

## Updating the bot
```bash
cd ~/nexustrade
git pull
cd bot-server
npm run build
pm2 restart nexustrade-bot
```

## Optional: HTTPS with nginx (recommended)
To use HTTPS between Vercel and your VM, install nginx + certbot and proxy port 3001.
This is optional — traffic between Vercel and Oracle already goes over a private connection if you use Oracle's VCN.
