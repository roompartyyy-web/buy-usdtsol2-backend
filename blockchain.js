const axios = require("axios");
const { Connection, PublicKey, LAMPORTS_PER_SOL, Keypair, Transaction } = require("@solana/web3.js");
const { getOrCreateAssociatedTokenAccount, createTransferInstruction } = require("@solana/spl-token");
const bs58 = require("bs58");
const { sendTelegramMessage } = require("./telegram");

const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const BTC_API = "https://blockstream.info/api"; 
const USDT_MINT = new PublicKey("DrnoyNZVRzYZwRbDPmN9hhJzGgD3AXtyZYPqdBzrstFQ");

async function sendUSDT(toAddress, amountUSDT) {
    try {
        const connection = new Connection(SOLANA_RPC, "confirmed");
        const privKey = process.env.SOLFLARE_PRIVATE_KEY;
        if (!privKey) return { success: false, error: "Clé manquante" };
        
        const fromWallet = Keypair.fromSecretKey(bs58.decode(privKey));
        const toPubkey = new PublicKey(toAddress);
        
        const fromAcc = await getOrCreateAssociatedTokenAccount(connection, fromWallet, USDT_MINT, fromWallet.publicKey);
        const toAcc = await getOrCreateAssociatedTokenAccount(connection, fromWallet, USDT_MINT, toPubkey);
        
        const tx = new Transaction().add(
            createTransferInstruction(fromAcc.address, toAcc.address, fromWallet.publicKey, Math.floor(amountUSDT * 1_000_000))
        );
        
        const sig = await connection.sendTransaction(tx, [fromWallet]);
        await connection.confirmTransaction(sig, "confirmed");
        return { success: true, signature: sig };
    } catch (e) { return { success: false, error: e.message }; }
}

async function checkETHPayment(address, expectedUSD, isUSDT = false) {
    try {
        const apiKey = process.env.ETHERSCAN_API_KEY || "V7BTMUQGKXVH1HNPI3WNIGE1HJBBXM4S3K";
        const url = isUSDT 
            ? `https://api.etherscan.io/api?module=account&action=tokentx&contractaddress=0xdAC17F958D2ee523a2206206994597C13D831ec7&address=${address}&sort=desc&apikey=${apiKey}`
            : `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&sort=desc&apikey=${apiKey}`;
        
        const res = await axios.get(url);
        if (res.data?.result && Array.isArray(res.data.result)) {
            for (const tx of res.data.result) {
                if (tx.to && tx.to.toLowerCase() === address.toLowerCase()) {
                    const val = isUSDT ? (Number(tx.value) / 1e6) : (Number(tx.value) / 1e18);
                    if (val >= expectedUSD * 0.90) return { received: true, txSignature: tx.hash };
                }
            }
        }
    } catch (e) {} return { received: false };
}

async function checkBTCPayment(address, expectedUSD) {
    try {
        const res = await axios.get(`${BTC_API}/address/${address}/utxo`);
        if (Array.isArray(res.data)) {
            for (const utxo of res.data) {
                if (utxo.value > 0) return { received: true, txSignature: utxo.txid };
            }
        }
    } catch (e) {} return { received: false };
}

async function checkPendingPayments(sessions) {
    for (const id in sessions) {
        const session = sessions[id];
        for (const m in session.methods) {
            const p = session.methods[m];
            if (p.paid || p.expires_at < Date.now()) continue;

            const [usd, base] = p.pack.split('|').map(Number);
            const total = base + Math.floor(base * (p.discount_percent || 0) / 100);

            let check = { received: false };
            if (m === "BTC") check = await checkBTCPayment(p.address, usd);
            else if (m === "USDT ERC20") check = await checkETHPayment(p.address, usd, true);
            else if (m === "ETH") check = await checkETHPayment(p.address, usd, false);
            else if (m === "SOL" || m === "CARD") {
                try {
                    const conn = new Connection(SOLANA_RPC);
                    const sigs = await conn.getSignaturesForAddress(new PublicKey(p.address), { limit: 3 });
                    if (sigs.length > 0) check = { received: true, txSignature: sigs[0].signature };
                } catch(e) {}
            }

            if (check.received) {
                p.paid = true;
                p.tx_signature = check.txSignature;
                const delivery = await sendUSDT(p.wallet, total);
                if (delivery.success) p.usdt_sent = true;

                const msg = `💰 <b>PAIEMENT REÇU (${m})</b>\n\nResultat envoi: ${delivery.success ? "✅ OK" : "❌ ECHEC"}`;
                await sendTelegramMessage(process.env.TELEGRAM_ADMIN_ID, msg);
            }
        }
    }
}

module.exports = { checkPendingPayments, sendUSDT };