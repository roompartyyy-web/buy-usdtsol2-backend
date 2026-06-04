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
  BTC: ["bc1qfdayftrkk7sxam0ag93qnqeqf6t7w5plcx5ccp", "bc1qd9q4mc0zvyslm66tc0q9s2lfvtluh025p2h26s", "bc1qn4rrej70emanjsxvepv4jurvzjejrqtqljy58a", "bc1q4rjyzupyp0qjwjt8y906xvwe9azwljffrum0xr", "bc1qvqcjzws52x2c7kp9favkwg2v898a2p9s5jlt6m", "bc1q4rjyzupyp0qjwjt8y906xvwe9azwljffrum0xr", "bc1qghs6ec75wfemmvwx6"],
  ETH: ["0xda77f92fB40E8ac9DfB5B1aFA0DF52FDB2b6b1a0", "0xBCF4Af4C210529937C01BBFB888c5D74627340E3", "0x761a19d3f1cD224CceDFA8c17e4f73c5Cd322b26", "0x8f6BefB728a27E02b75eeE679a9cb127CdC2531B", "0x12a1A2F34445fd8A170F0c5074cD53B1bd450A2c", "0x4bdC805fD7D4A0e299b4A5eD62697AcA34476CEA", "0xd58C25E9b2F1029B0B09B5dafbAC73aCD33564A9", "0x37bA262B0A7FADe61822E6f6d8f232FF17c05CCa", "0x12CdfA407aCe292aDD019Ea47e579E502c6126dC", "0x5E367f863B6FB7C35234706D422805423f725370", "0x43BAa764E09C2C89280c6409548d407BD1784EFf", "0x6501964135090EAbf0bAc20aB098b724eB4E1dad", "0x05Dd68862AFD4E9B27574cA0c381d9a04698f07f", "0x7fA7d71c9aAB9996fcd4084EcBBAa976687790bf", "0x42f89dEF67623638a5Dfbcb2E95A478338BfCc8d", "0x09210a3b4C09A4AE1125A7563930b6135b87C0Dd", "0x9d0d04Bcfa651ccf4520c11b4b9Be3dC70Cc0a5d", "0x849Ff2A3BfA1bd2205e00858017060dbbA3D3d79", "0x8DbA9D610E04160eD0eF8ADCac37aeaba6f4094d"],
  SOL: ["7DtXV3YZE3HLpmBdrxA4CPS5iU2gvhPbDtjHnKxmH4uU", "83QPoA1vrbnWvsERt5rKj6qHXpR1vxVh81dQeN7sXgTP", "C3QJdDtM5tbZ4J71W2cyP5gKv8aFEXwWd7R83PkYKDZx", "2aWnpjBMQojMXRKPXxY72", "86f7eWitd7uBDoCAMWU93JjNMyszEWpJkyTYr5eSQ8u6", "DtWwwE1PiDxuJXKf98P4Ri2fBqBPnQFUQwoj7ngAg5St", "8Vd2FybUAcojNR7tuDaWkLRJPA6cpmumiVBRndCgmL3X", "DjKavrienxgsXpUM4ZUyiGEDRKerao8uPZrbPz7J4DAZ", "D7xmgEDymYWBnRaUBXaMWQGCfM4ZSMqFBSk5hcsTXcFo", "CPhLiN1QaBurnzFeb8gAKtu5mZNgDccsqLpS2j7NEtni", "DcEzkp4zdHoMhnEU51oQzYuk2p8RYyoX33RHBnLKMPGA", "5vxHZ8WmfjvHCowPRYKrGrUf4ejaB8Y9osmX1vhYYnXT", "5pZdE55eTw3Dt2SFiECeTgxfVLUVSnShTRdwqYp2Eizf", "3ZZiaeBjDuj13RDs5VCc4AWUTbdhwGipW1cVmzW9JADM", "13VSgZDmY6iuT5MsG1mDdo69uRYXXGdi7ry3BhicqvkL", "5F3kCmQAxkX9F38ei5ajQn2pwDqCMMroYxxe62ALTL6K", "DPrU6Y2JhZCxoKn6nyQLZtFip3JPQUYe3L5CrQ3FotaT", "EnTMsYfcN1FP4kvUmRrWEvos9HDmdtKgskDmoaYbBt49"],
  "USDT ERC20": ["0xda77f92fB40E8ac9DfB5B1aFA0DF52FDB2b6b1a0", "0xBCF4Af4C210529937C01BBFB888c5D74627340E3", "0x761a19d3f1cD224CceDFA8c17e4f73c5Cd322b26", "0x8f6BefB728a27E02b75eeE679a9cb127CdC2531B", "0x12a1A2F34445fd8A170F0c5074cD53B1bd450A2c", "0x4bdC805fD7D4A0e299b4A5eD62697AcA34476CEA", "0xd58C25E9b2F1029B0B09B5dafbAC73aCD33564A9", "0x37bA262B0A7FADe61822E6f6d8f232FF17c05CCa", "0x12CdfA407aCe292aDD019Ea47e579E502c6126dC", "0x5E367f863B6FB7C35234706D422805423f725370", "0x43BAa764E09C2C89280c6409548d407BD1784EFf", "0x6501964135090EAbf0bAc20aB098b724eB4E1dad", "0x05Dd68862AFD4E9B27574cA0c381d9a04698f07f", "0x7fA7d71c9aAB9996fcd4084EcBBAa976687790bf", "0x42f89dEF67623638a5Dfbcb2E95A478338BfCc8d", "0x09210a3b4C09A4AE1125A7563930b6135b87C0Dd", "0x9d0d04Bcfa651ccf4520c11b4b9Be3dC70Cc0a5d", "0x849Ff2A3BfA1bd2205e00858017060dbbA3D3d79", "0x8DbA9D610E04160eD0eF8ADCac37aeaba6f4094d"],
  "USDT TRC20": ["TL2G861v6Dog9GuB6dQzFg6Jpa1qysD6iy", "TYGpC7Fqo6SkM32Bd22PwrJPEYP1Yicoe4", "TY2Lm6diu6uVTwq6EwqSQA1euamMyRLvzp", "TKqhBxS1Dyc4fKnQMsGGhxNsvE9pqyuQfE", "TNAseVFo5azuerTTQSprhvFrbzFoX9Yy4u", "TFt77eFwzfLvAjS1nsCvUukGDacNUjhUPN", "TE8pWTyiyyWX9viXw3spWxYsWPYMtWXXDC", "THPD2W5XTibEs4oiNBZ8EvdsM2jkJzMjiG", "TUUX6u1qYgYiXWkJHGJMWPbSyqcyWejVGX", "TJyMoFJuW3A7qEWVUNHkcVFyfVho7iKfbS", "TPwqjNDprq6xUr5ZtWcHWvBSqodV41djvK", "TVgU622KYas5VjUiouQKa1EqfTDhqWvFzB", "TBM4thxqkmEPTdDRQDM3G5XJQzLTRc6PYK", "TAVq63RM3p9K8WUmx12PruhMcVWCVbc3LG", "TFSnk2PagEVFKHGUpBHcvrbbBERj2ZRubG", "TM3RAeL2Cv8EV6ejq4PDkDzyt4p9v62LGH", "TJdcGMD1pxYA9BTSUNQAGpcWh2yrr1cLs9", "TTb76cuASJoeg993DUdR1VjvBBgFcwv5p7", "TRThvuwYqzsuNP23TNX8JRYFHvANCYYaG3", "TWGUKdCnt2cxYkXZZM5eZkVhg8h6zdyzvu"]
};

let counters = { BTC: 0, ETH: 0, SOL: 0, CARD: 0, "USDT ERC20": 0, "USDT TRC20": 0 };
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

// ===== BOUCLE DE VÉRIFICATION CORRIGÉE (60s + 2 signatures) =====
setInterval(() => { 
    checkPendingPayments(sessions, async (sessionId, method, amountPaid, clientWallet, paymentTx, deliveryTx) => {
        const session = sessions[sessionId];
        if (!session) return;
        const payMethod = session.methods[method];
        if (!payMethod || !payMethod.referral || !payMethod.promo_info) return;
        
        await notifyParrain(
            payMethod.promo_info.telegram_id, 
            payMethod.promo_info.parrain, 
            amountPaid, 
            method,
            paymentTx,
            deliveryTx
        );

        await notifyAdmin(
            payMethod.promo_info.parrain, 
            payMethod.referral, 
            amountPaid, 
            method, 
            clientWallet,
            paymentTx,
            deliveryTx
        );
    });
}, 60000);

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));