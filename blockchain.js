const axios = require("axios");
const { Connection, PublicKey, Keypair, Transaction } = require("@solana/web3.js");
const { getOrCreateAssociatedTokenAccount, createTransferInstruction } = require("@solana/spl-token");
const bs58 = require("bs58");

// Utilise la variable d'env ou le RPC public en fallback
const SOLANA_RPC = process.env.SOLANA_RPC || "https://mainnet.helius-rpc.com/?api-key=764be8a6-6eb9-4994-9dee-da135e6b48c3";
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

async function checkPendingPayments(sessions, callback) {
    console.log(`[CHECK] Vérification de ${Object.keys(sessions).length} sessions...`);
    
    for (const id in sessions) {
        for (const m in sessions[id].methods) {
            const p = sessions[id].methods[m];
            if (p.paid || p.expires_at < Date.now()) continue;

            const [usd] = p.pack.split('|').map(Number);
            let check = { received: false, signature: null };

            // === SOL / CARD ===
            if (m === "SOL" || m === "CARD") {
                try {
                    const conn = new Connection(SOLANA_RPC, "confirmed");
                    const sigs = await conn.getSignaturesForAddress(new PublicKey(p.address), { limit: 5 });
                    
                    for (const sigInfo of sigs) {
                        const txTime = (sigInfo.blockTime || 0) * 1000;
                        if (txTime > sessions[id].created_at) {
                            let tx = null;
                            try {
                                tx = await conn.getTransaction(sigInfo.signature, { 
                                    maxSupportedTransactionVersion: 0, 
                                    commitment: "confirmed" 
                                });
                            } catch(e1) {
                                try {
                                    tx = await conn.getTransaction(sigInfo.signature, { 
                                        commitment: "confirmed" 
                                    });
                                } catch(e2) {
                                    console.error("[GETTX] Erreur:", e2.message);
                                    continue;
                                }
                            }
                            
                            if (tx) {
                                const balanceIndex = tx.transaction.message.staticAccountKeys.findIndex(pubkey => pubkey.toBase58() === p.address);
                                if (balanceIndex !== -1) {
                                    const receivedLamports = tx.meta.postBalances[balanceIndex] - tx.meta.preBalances[balanceIndex];
                                    if (receivedLamports > 0) {
                                        const amountSOL = receivedLamports / 1e9;
                                        const priceRes = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
                                        const solPrice = priceRes.data.solana.usd;
                                        const amountInUSD = amountSOL * solPrice;
                                        console.log(`[DÉTECTION] Reçu: ${amountInUSD.toFixed(2)}$ | Attendu: ${usd}$`);
                                        if (amountInUSD >= (usd * 0.90)) {
                                            console.log(`[DÉTECTION] ✅ PAIEMENT VALIDÉ !`);
                                            check = { received: true, signature: sigInfo.signature };
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                } catch(e) { 
                    console.error("Err SOL:", e.message); 
                    if (e.message.includes("429")) {
                        console.log("[CHECK] Rate limit atteint, attente du prochain cycle...");
                    }
                }
            }

            // === ETH / USDT ERC20 ===
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
                        if (tx.to && tx.to.toLowerCase() === p.address.toLowerCase() && Number(tx.timeStamp) * 1000 > sessions[id].created_at) {
                            let amountInUSD = 0;
                            if (isUSDT) amountInUSD = Number(tx.value) / 1000000;
                            else {
                                const ethPrice = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
                                amountInUSD = (Number(tx.value) / 1e18) * ethPrice.data.ethereum.usd;
                            }
                            if (amountInUSD >= (usd * 0.90)) check = { received: true, signature: tx.hash };
                        }
                    }
                } catch(e) { console.error("Err ETH:", e.message); }
            }

            // === ENVOI DES TOKENS ===
            if (check.received) {
                p.paid = true;
                console.log(`[ENVOI] ${p.total_tokens} USDT -> ${p.wallet.slice(0,8)}...`);
                const delivery = await sendUSDT(p.wallet, p.total_tokens);
                if (delivery.success) {
                    p.usdt_sent = true;
                    p.usdt_tx_signature = delivery.signature;
                    console.log(`[ENVOI] ✅ USDT envoyé ! Signature: ${delivery.signature.slice(0,12)}...`);
                    if (callback) await callback(id, m, usd, p.wallet, delivery.signature);
                } else {
                    console.error("[ENVOI] ❌ Échec:", delivery.error);
                }
            }
        }
    }
}

module.exports = { checkPendingPayments };