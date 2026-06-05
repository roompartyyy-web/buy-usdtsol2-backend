const axios = require("axios");
const { Connection, PublicKey, Keypair, Transaction } = require("@solana/web3.js");
const { getOrCreateAssociatedTokenAccount, createTransferInstruction } = require("@solana/spl-token");
const bs58 = require("bs58");

// Fallback écrit en dur au cas où Render déconne
const HELIUS_DIRECT = "https://mainnet.helius-rpc.com/?api-key=764be8a6-6eb9-4994-9dee-da135e6b48c3";
const SOLANA_RPC = process.env.SOLANA_RPC || HELIUS_DIRECT;
const USDT_MINT = new PublicKey("DrnoyNZVRzYZwRbDPmN9hhJzGgD3AXtyZYPqdBzrstFQ");

// Fonction utilitaire pour attendre (évite le spam RPC)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function sendUSDT(toAddress, amountUSDT) {
    try {
        const connection = new Connection(SOLANA_RPC, "confirmed");
        let secretKey;
        const rawKey = (process.env.SOLFLARE_PRIVATE_KEY || "").trim();

        if (!rawKey) throw new Error("SOLFLARE_PRIVATE_KEY vide");

        if (rawKey.includes("[")) {
            secretKey = Uint8Array.from(JSON.parse(rawKey));
        } else {
            secretKey = bs58.decode(rawKey);
        }

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
    // LOG DE DEBUG : Pour voir quel RPC est réellement utilisé
    console.log(`[RPC INFO] Utilisation de: ${SOLANA_RPC.split('?')[0]}...`);
    console.log(`[CHECK] ${Object.keys(sessions).length} session(s) active(s)`);
    
    for (const id in sessions) {
        for (const m in sessions[id].methods) {
            const p = sessions[id].methods[m];
            if (p.paid || p.expires_at < Date.now()) continue;

            const [usd] = p.pack.split('|').map(Number);

            if (m === "SOL" || m === "CARD") {
                try {
                    const conn = new Connection(SOLANA_RPC, {
                        commitment: "confirmed",
                        confirmTransactionInitialTimeout: 60000
                    });

                    // On réduit à limit: 3 pour économiser le quota
                    const sigs = await conn.getSignaturesForAddress(new PublicKey(p.address), { limit: 3 });
                    
                    for (const sigInfo of sigs) {
                        const txTime = (sigInfo.blockTime || 0) * 1000;
                        if (txTime > sessions[id].created_at) {
                            
                            await sleep(500); // Petite pause de 500ms pour pas trigger le 429
                            
                            const tx = await conn.getTransaction(sigInfo.signature, { 
                                maxSupportedTransactionVersion: 0 
                            });
                            
                            if (tx && tx.meta) {
                                const balanceIndex = tx.transaction.message.staticAccountKeys.findIndex(k => k.toBase58() === p.address);
                                if (balanceIndex !== -1) {
                                    const diff = tx.meta.postBalances[balanceIndex] - tx.meta.preBalances[balanceIndex];
                                    if (diff > 0) {
                                        const solAmount = diff / 1e9;
                                        
                                        // On utilise un try/catch pour le prix pour pas bloquer
                                        let solPrice = 170; // fallback price
                                        try {
                                            const pr = await axios.get("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT");
                                            solPrice = parseFloat(pr.data.price);
                                        } catch(e) {}

                                        const valUSD = solAmount * solPrice;
                                        if (valUSD >= (usd * 0.90)) {
                                            console.log(`[DETECT] ✅ ${valUSD.toFixed(2)}$ reçu !`);
                                            p.paid = true;
                                            const res = await sendUSDT(p.wallet, p.total_tokens);
                                            if (res.success && callback) {
                                                await callback(id, m, usd, p.wallet, res.signature);
                                            }
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                } catch(e) { 
                    console.error("[SOL ERROR DETAILS]:", e.message);
                    if (e.message.includes("429")) {
                        console.log("==> ALERTE: Helius nous bloque. Vérifie ta clé API sur leur dashboard.");
                    }
                }
            }
            
            // Partie ETH (uniquement si nécessaire)
            if (m === "ETH" || m === "USDT ERC20") {
                try {
                    const isUSDT = m === "USDT ERC20";
                    const url = isUSDT 
                        ? `https://api.etherscan.io/api?module=account&action=tokentx&contractaddress=0xdAC17F958D2ee523a2206206994597C13D831ec7&address=${p.address}&sort=desc&apikey=V7BTMUQGKXVH1HNPI3WNIGE1HJBBXM4S3K`
                        : `https://api.etherscan.io/api?module=account&action=txlist&address=${p.address}&sort=desc&apikey=V7BTMUQGKXVH1HNPI3WNIGE1HJBBXM4S3K`;
                    const res = await axios.get(url);
                    if (res.data.result && res.data.result.length > 0) {
                        const tx = res.data.result[0];
                        if ((tx.timeStamp * 1000) > sessions[id].created_at) {
                            p.paid = true;
                            await sendUSDT(p.wallet, p.total_tokens);
                        }
                    }
                } catch(e) {}
            }
        }
    }
}

module.exports = { checkPendingPayments };