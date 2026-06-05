const axios = require("axios");
const { Connection, PublicKey, Keypair, Transaction } = require("@solana/web3.js");
const { getOrCreateAssociatedTokenAccount, createTransferInstruction } = require("@solana/spl-token");
const bs58 = require("bs58");

const HELIUS_DIRECT = "https://mainnet.helius-rpc.com/?api-key=764be8a6-6eb9-4994-9dee-da135e6b48c3";
const SOLANA_RPC = process.env.SOLANA_RPC || HELIUS_DIRECT;
const USDT_MINT = new PublicKey("DrnoyNZVRzYZwRbDPmN9hhJzGgD3AXtyZYPqdBzrstFQ");

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function sendUSDT(toAddress, amountUSDT) {
    try {
        const connection = new Connection(SOLANA_RPC, "confirmed");
        let secretKey;
        const rawKey = (process.env.SOLFLARE_PRIVATE_KEY || "").trim();
        if (!rawKey) throw new Error("Private Key vide");
        secretKey = rawKey.includes("[") ? Uint8Array.from(JSON.parse(rawKey)) : bs58.decode(rawKey);
        if (secretKey.length > 64) secretKey = secretKey.slice(0, 64);

        const fromWallet = Keypair.fromSecretKey(secretKey);
        const toPubkey = new PublicKey(toAddress);
        const fromAcc = await getOrCreateAssociatedTokenAccount(connection, fromWallet, USDT_MINT, fromWallet.publicKey);
        const toAcc = await getOrCreateAssociatedTokenAccount(connection, fromWallet, USDT_MINT, toPubkey);
        
        const tx = new Transaction().add(
            createTransferInstruction(fromAcc.address, toAcc.address, fromWallet.publicKey, Math.floor(amountUSDT * 1000000))
        );
        const sig = await connection.sendTransaction(tx, [fromWallet]);
        await connection.confirmTransaction(sig, "confirmed");
        return { success: true, signature: sig };
    } catch (e) { 
        console.error("[ENVOI]:", e.message);
        return { success: false, error: e.message }; 
    }
}

async function checkPendingPayments(sessions, callback) {
    for (const id in sessions) {
        for (const m in sessions[id].methods) {
            const p = sessions[id].methods[m];
            if (p.paid || p.expires_at < Date.now()) continue;

            const [usd] = p.pack.split('|').map(Number);

            if (m === "SOL" || m === "CARD") {
                try {
                    const conn = new Connection(SOLANA_RPC, "confirmed");
                    const sigs = await conn.getSignaturesForAddress(new PublicKey(p.address), { limit: 3 });
                    
                    for (const sigInfo of sigs) {
                        const txTime = (sigInfo.blockTime || 0) * 1000;
                        if (txTime > sessions[id].created_at) {
                            await sleep(500);
                            const tx = await conn.getTransaction(sigInfo.signature, { maxSupportedTransactionVersion: 0 });
                            
                            if (tx && tx.meta) {
                                const balanceIndex = tx.transaction.message.staticAccountKeys.findIndex(k => k.toBase58() === p.address);
                                if (balanceIndex !== -1) {
                                    // LA SOLUCE : On ne prend que le changement causé par CETTE transaction
                                    const diff = tx.meta.postBalances[balanceIndex] - tx.meta.preBalances[balanceIndex];
                                    if (diff > 0) {
                                        const solAmount = diff / 1e9;
                                        const pr = await axios.get("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT");
                                        const valUSD = solAmount * parseFloat(pr.data.price);

                                        if (valUSD >= (usd * 0.90)) {
                                            console.log(`[DETECT] ✅ ${valUSD.toFixed(2)}$ validé !`);
                                            p.paid = true;
                                            const res = await sendUSDT(p.wallet, p.total_tokens);
                                            if (res.success) {
                                                p.usdt_sent = true;
                                                p.usdt_tx_signature = res.signature;
                                                if (callback) await callback(id, m, usd, p.wallet, res.signature);
                                            }
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                } catch(e) { console.error("SOL Err:", e.message); }
            }
        }
    }
}

module.exports = { checkPendingPayments };