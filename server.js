require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
const { checkPendingPayments } = require("./blockchain");
const { notifyParrain, notifyAdmin } = require("./telegram");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const wallets = {
  CARD: ["3FWy6LjDQ17SY6czWjREy3C84R2gmSPaTEvTW9oPE33B", "2FShUVxTGzDVfzUsuJfUMuRYoBSdBWeFhKieMEJ1Q9gy", "2CNgSTKaEhXxkRmir3XU81Ur15YQQBZyVDhNkq5eQqAt", "GbtcvPDPxvSZ96CCcBafbpnttX2CyWhNbKjFSz6AfJa4", "ST52drfrp2SVmkQJaaj5MydB4oNymNyr6DpKZouuf5i", "5o6hsVugKNYbPSAptZ3asKdZwvum9DfYucx4AVEXyXET", "4542iDgnGRMawNtURVVvx9VJf8F3VB4EdFtWBEmD3oLh", "4CpbLrYgJxuWpBLRS2z97AZmH6jDkmbtMa3L2q7qT3KE", "7dMexakhYyRJSeGpfnFtsD8p8rxeiAh5HvsZiUPE5GCC", "AXU5ZX8JN2LTwyH79GGd3GSCVd1MG8X3eFEGt12ebSt2", "7Lj5wKmkffA7BsoNmieUPLvs4LvkV8XjjEnhkGbNK2JK", "FcX7eHLMWhSnhcdJwKRe6tM76mKXR7hhtskRFYXSyND3", "CvE4ZdDvbM4NNrgb32Uu3mYiMGDoXW2Mbv6midPZpgAF", "7dtDdUCzXCvjHZ4SkWQtcqjZSEKDSuzttjhzoWrekq45", "4egn3EDXXNvcvSAdxqy8BExr4RUcTzV9UHatWkSrUPuL", "5jR47fFqkjWLRk8VLpx3VC6ZEo7fcY5dHzCWwm8aPmwN", "9iwKavVdxP82HKSbaZSoRHwuRoTGGJP86pjBC3b1BFMJ", "1fZAjLFyPbCegiyQViZX6wckUapPp4SztF84Rtgwms6", "EZ3sdtuBBX1sWpqnSBgNNXZD7yeLXPLF2s2K2jwxEqru", "AJtZoYs2RDKz9AsDXG1wUPmcfyUbciwFWPim9TU9Eg97"],
  SOL: ["GEX4qS7sUJm7iWbHuvRfVcMVgM4KVQSBGmmrAeLCGxqX", "855eyqBotWU36Hs63jJwKhZBNikv42uYXeFp52SifRjz", "472PXQ3KqMfxzoS7JLs6B8uqB7A9NgqxwWmnJ8GVYtyL", "BwMtJMJZAwiNoBXSB78eV8LACSq4vCoiyrZU83mGQNvp", "76trByKzsCW8YfmPd9Wc65f5jkzezA588JtLZDGUbbGz", "4GbHukt3or6dtGxG2NBjrA42yTQrZJ4EojMXRKPXxY72", "86f7eWitd7uBDoCAMWU93JjNMyszEWpJkyTYr5eSQ8u6", "DtWwwE1PiDxuJXKf98P4Ri2fBqBPnQFUQwoj7ngAg5St", "8Vd2FybUAcojNR7tuDaWkLRJPA6cpmumiVBRndCgmL3X", "DjKavrienxgsXpUM4ZUyiGEDRKerao8uPZrbPz7J4DAZ", "D7xmgEDymYWBnRaUBXaMWQGCfM4ZSMqFBSk5hcsTXcFo", "CPhLiN1QaBurnzFeb8gAKtu5mZNgDccsqLpS2j7NEtni", "DcEzkp4zdHoMhnEU51oQzYuk2p8RYyoX33RHBnLKMPGA", "5vxHZ8WmfjvHCowPRYKrGrUf4ejaB8Y9osmX1vhYYnXT", "5pZdE55eTw3Dt2SFiECeTgxfVLUVSnShTRdwqYp2Eizf", "3ZZiaeBjDuj13RDs5VCc4AWUTbdhwGipW1cVmzW9JADM", "13VSgZDmY6iuT5MsG1mDdo69uRYXXGdi7ry3BhicqvkL", "5F3kCmQAxkX9F38ei5ajQn2pwDqCMMroYxxe62ALTL6K", "DPrU6Y2JhZCxoKn6nyQLZtFip3JPQUYe3L5CrQ3FotaT", "EnTMsYfcN1FP4kvUmRrWEvos9HDmdtKgskDmoaYbBt49"]
};

let counters = { SOL: 0, CARD: 0 };
let sessions = {};

function loadPromoCodes() {
    try {
        const filePath = path.resolve(__dirname, "promo-codes.json");
        return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf-8")) : {};
    } catch (e) { return {}; }
}

app.get("/api/payment/status/:sessionId/:method", (req, res) => {
    const { sessionId, method } = req.params;
    if (!sessions[sessionId] || !sessions[sessionId].methods[method]) return res.json({ status: "not_found" });
    const pay = sessions[sessionId].methods[method];
    res.json({
        status: pay.paid ? (pay.usdt_sent ? "completed" : "detected") : "waiting",
        wallet: pay.wallet,
        tx: pay.usdt_tx_signature || null
    });
});

app.post("/api/check-code", (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ valid: false });
    const promo = loadPromoCodes()[code.trim().toLowerCase()];
    if (promo) return res.json({ valid: true, percentage: promo.discount, parrain: promo.parrain });
    res.status(404).json({ valid: false });
});

app.post("/api/payment/init", (req, res) => {
    try {
        const { pack, wallet, payment_method, session_id, referral } = req.body;
        let sessionId = session_id || uuidv4();
        if (!sessions[sessionId]) sessions[sessionId] = { created_at: Date.now(), methods: {} };

        const existing = sessions[sessionId].methods[payment_method];
        if (existing) {
            if (existing.pack !== pack || existing.wallet !== wallet || existing.paid || existing.expires_at <= Date.now()) {
                delete sessions[sessionId].methods[payment_method];
            } else {
                return res.json({
                    success: true, session_id: sessionId, unique_payment_address: existing.address,
                    pack, total_tokens: existing.total_tokens, expires_at: existing.expires_at,
                    discount_percent: existing.bonus_percentage || 0, bonus_tokens: existing.bonus_tokens || 0
                });
            }
        }

        const list = wallets[payment_method];
        const address = list[counters[payment_method] % list.length];
        counters[payment_method]++;
        
        const expiresAt = Date.now() + (payment_method === "CARD" ? 90 : 45) * 60000;
        const baseToken = Number(pack.split('|')[1]);
        
        let bonusPct = 0, promoInfo = null;
        if (referral) {
            promoInfo = loadPromoCodes()[referral.trim().toLowerCase()];
            if (promoInfo) bonusPct = promoInfo.discount;
        }
        
        const bonusTkn = baseToken * bonusPct / 100;
        const totalTkn = baseToken + bonusTkn;
        
        sessions[sessionId].methods[payment_method] = {
            address, wallet, pack, expires_at: expiresAt, referral, 
            paid: false, usdt_sent: false, total_tokens: totalTkn, base_tokens: baseToken,
            bonus_percentage: bonusPct, bonus_tokens: bonusTkn, promo_info: promoInfo
        };

        res.json({
            success: true, session_id: sessionId, unique_payment_address: address,
            pack, total_tokens: totalTkn, expires_at: expiresAt,
            discount_percent: bonusPct, bonus_tokens: bonusTkn
        });
    } catch(e) { res.status(500).json({ success: false }); }
});

// ===== BOUCLE DE VÉRIFICATION RAPIDE (15s) =====
setInterval(() => { 
    checkPendingPayments(sessions, async (sessionId, method, amountPaid, clientWallet, txSignature) => {
        const session = sessions[sessionId];
        if (!session) return;
        const payMethod = session.methods[method];
        if (!payMethod || !payMethod.referral || !payMethod.promo_info) return;
        
        await notifyParrain(
            payMethod.promo_info.telegram_id, 
            payMethod.promo_info.parrain, 
            amountPaid, 
            method,
            txSignature
        );

        await notifyAdmin(
            payMethod.promo_info.parrain, 
            payMethod.referral, 
            amountPaid, 
            method, 
            clientWallet,
            txSignature
        );
    });
}, 5000); // Vérifie toutes les 15 SECONDES au lieu de 30

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));