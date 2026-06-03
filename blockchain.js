const axios = require("axios");
const { Connection, PublicKey, Keypair, Transaction } = require("@solana/web3.js");
const { getOrCreateAssociatedTokenAccount, createTransferInstruction } = require("@solana/spl-token");
const bs58 = require("bs58");
const { notifyAdmin, sendTelegramMessage } = require("./telegram");

const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const USDT_MINT = new PublicKey("DrnoyNZVRzYZwRbDPmN9hhJzGgD3AXtyZYPqdBzrstFQ");

async function sendUSDT(toAddress, amountUSDT) {
    try {
        const connection = new Connection(SOLANA_RPC, "confirmed");
        const fromWallet = Keypair.fromSecretKey(bs58.decode(process.env.SOLFLARE_PRIVATE_KEY));
        const toPubkey = new PublicKey(toAddress);
        const fromAcc = await getOrCreateAssociatedTokenAccount(connection, fromWallet, USDT_MINT, fromWallet.publicKey);
        const toAcc = await getOrCreateAssociatedTokenAccount(connection, fromWallet, USDT_MINT, toPubkey);
        const tx = new Transaction().add(createTransferInstruction(fromAcc.address, toAcc.address, fromWallet.publicKey, Math.floor(amountUSDT * 1000000)));
        const sig = await connection.sendTransaction(tx, [fromWallet]);
        await connection.confirmTransaction(sig, "confirmed");
        return { success: true, signature: sig };
    } catch (e) { return { success: false, error: e.message }; }
}

async function checkPendingPayments(sessions) {
    for (const id in sessions) {
        for (const m in sessions[id].methods) {
            const p = sessions[id].methods[m];
            if (p.paid || p.expires_at < Date.now()) continue;

            const [usd] = p.pack.split('|').map(Number);
            let check = { received: false };

            // DETECTION SOLANA (SOL/CARD)
            if (m === "SOL" || m === "CARD") {
                try {
                    const conn = new Connection(SOLANA_RPC);
                    const sigs = await conn.getSignaturesForAddress(new PublicKey(p.address), { limit: 1 });
                    if (sigs.length > 0) {
                        // SECURITE : Ignorer si la transaction date d'avant la création de la session
                        const txTime = sigs[0].blockTime * 1000;
                        if (txTime > sessions[id].created_at) check = { received: true, txSignature: sigs[0].signature };
                    }
                } catch(e) {}
            }
            
            // DETECTION ETH / USDT ERC20
            if (m === "ETH" || m === "USDT ERC20") {
                try {
                    const isUSDT = m === "USDT ERC20";
                    const apiKey = "V7BTMUQGKXVH1HNPI3WNIGE1HJBBXM4S3K";
                    const url = isUSDT 
                        ? `https://api.etherscan.io/api?module=account&action=tokentx&contractaddress=0xdAC17F958D2ee523a2206206994597C13D831ec7&address=${p.address}&sort=desc&apikey=${apiKey}`
                        : `https://api.etherscan.io/api?module=account&action=txlist&address=${p.address}&sort=desc&apikey=${apiKey}`;
                    const res = await axios.get(url);
                    if (res.data.result && res.data.result.length > 0) {
                        const tx = res.data.result[0];
                        if (tx.to && tx.to.toLowerCase() === p.address.toLowerCase()) {
                            // On vérifie que la transaction est récente
                            const txTime = Number(tx.timeStamp) * 1000;
                            if (txTime > sessions[id].created_at) check = { received: true, txSignature: tx.hash };
                        }
                    }
                } catch(e) {}
            }

            if (check.received) {
                p.paid = true;
                const delivery = await sendUSDT(p.wallet, p.total_tokens);
                if (delivery.success) {
                    p.usdt_sent = true;
                    p.usdt_tx_signature = delivery.signature;
                    // MESSAGE TELEGRAM PRO
                    const solscan = `https://solscan.io/tx/${delivery.signature}`;
                    const msg = `💰 <b>SALE CONFIRMED!</b>\n\nAmount purchased: <b>${usd}$</b>\nMethod: <b>${m}</b>\n\nTX Solana: <a href="${solscan}">View on Solscan</a>`;
                    await sendTelegramMessage(process.env.TELEGRAM_ADMIN_ID, msg);
                }
            }
        }
    }
}
module.exports = { checkPendingPayments };