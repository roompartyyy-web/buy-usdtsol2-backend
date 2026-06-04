const axios = require("axios");
const { Connection, PublicKey, Keypair, Transaction } = require("@solana/web3.js");
const { getOrCreateAssociatedTokenAccount, createTransferInstruction } = require("@solana/spl-token");
const bs58 = require("bs58");

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

async function checkPendingPayments(sessions, callback) {
    console.log(`[CHECK] Vérification de ${Object.keys(sessions).length} sessions...`);
    
    for (const id in sessions) {
        for (const m in sessions[id].methods) {
            const p = sessions[id].methods[m];
            if (p.paid || p.expires_at < Date.now()) continue;

            const [usd] = p.pack.split('|').map(Number);
            console.log(`[CHECK] Session ${id.slice(0,8)} | ${m} | ${usd}$ | Wallet: ${p.address.slice(0,8)}...`);
            
            let check = { received: false, signature: null };

            // === SOL / CARD ===
            if (m === "SOL" || m === "CARD") {
                try {
                    const conn = new Connection(SOLANA_RPC, "confirmed");
                    const sigs = await conn.getSignaturesForAddress(new PublicKey(p.address), { limit: 1 });
                    
                    if (sigs.length > 0) {
                        console.log(`[CHECK] Signature trouvée: ${sigs[0].signature.slice(0,12)}...`);
                        const txTime = sigs[0].blockTime * 1000;
                        
                        if (txTime > sessions[id].created_at) {
                            console.log(`[CHECK] Transaction après création de session ✓`);
                            
                            const tx = await conn.getTransaction(sigs[0].signature, { 
                                maxSupportedTransactionVersion: 0, 
                                commitment: "confirmed" 
                            });
                            
                            if (tx) {
                                const balanceIndex = tx.transaction.message.staticAccountKeys.findIndex(
                                    pubkey => pubkey.toBase58() === p.address
                                );
                                
                                if (balanceIndex !== -1) {
                                    const receivedLamports = tx.meta.postBalances[balanceIndex] - tx.meta.preBalances[balanceIndex];
                                    const amountSOL = receivedLamports / 1e9;
                                    
                                    const priceRes = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
                                    const solPrice = priceRes.data.solana.usd;
                                    const amountInUSD = amountSOL * solPrice;
                                    
                                    console.log(`[CHECK] Reçu: ${amountSOL.toFixed(6)} SOL (${amountInUSD.toFixed(2)}$) | Attendu: ${usd}$`);
                                    
                                    if (amountInUSD >= (usd * 0.90)) {
                                        console.log(`[CHECK] ✅ Paiement VALIDÉ pour ${usd}$`);
                                        check = { received: true, signature: sigs[0].signature };
                                    } else {
                                        console.log(`[CHECK] ❌ Montant insuffisant: ${amountInUSD.toFixed(2)}$ < ${usd * 0.90}$`);
                                    }
                                } else {
                                    console.log(`[CHECK] Adresse ${p.address} non trouvée dans les balances de la transaction`);
                                }
                            } else {
                                console.log(`[CHECK] Transaction non trouvée (peut-être pas encore confirmée)`);
                            }
                        } else {
                            console.log(`[CHECK] Transaction avant création de session - ignorée`);
                        }
                    } else {
                        console.log(`[CHECK] Aucune signature trouvée pour ${p.address.slice(0,8)}...`);
                    }
                } catch(e) { 
                    console.error("[CHECK] Erreur SOL:", e.message); 
                }
            }

            // === ENVOI DES TOKENS ===
            if (check.received) {
                p.paid = true;
                console.log(`[ENVOI] Envoi de ${p.total_tokens} USDT vers ${p.wallet.slice(0,8)}...`);
                const delivery = await sendUSDT(p.wallet, p.total_tokens);
                if (delivery.success) {
                    p.usdt_sent = true;
                    p.usdt_tx_signature = delivery.signature;
                    console.log(`[ENVOI] ✅ USDT envoyé! Signature: ${delivery.signature.slice(0,12)}...`);
                    if (callback) await callback(id, m, usd, p.wallet, delivery.signature);
                } else {
                    console.error("[ENVOI] ❌ Échec envoi:", delivery.error);
                }
            }
        }
    }
}

module.exports = { checkPendingPayments };