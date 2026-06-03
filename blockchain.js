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
    for (const id in sessions) {
        for (const m in sessions[id].methods) {
            const p = sessions[id].methods[m];
            if (p.paid || p.expires_at < Date.now()) continue;

            const [usd] = p.pack.split('|').map(Number);
            let check = { received: false, signature: null };

            // --- DÉTECTION SOLANA (SOL / CARD) ---
            if (m === "SOL" || m === "CARD") {
                try {
                    const conn = new Connection(SOLANA_RPC, "confirmed");
                    const sigs = await conn.getSignaturesForAddress(new PublicKey(p.address), { limit: 1 });
                    
                    if (sigs.length > 0) {
                        const sigInfo = sigs[0];
                        const txTime = sigInfo.blockTime * 1000;

                        if (txTime > sessions[id].created_at) {
                            // On récupère la transaction avec le support complet des versions
                            const tx = await conn.getTransaction(sigInfo.signature, {
                                maxSupportedTransactionVersion: 0,
                                commitment: "confirmed"
                            });

                            if (tx) {
                                // Calcul automatique du montant reçu sur l'adresse de paiement
                                const balanceIndex = tx.transaction.message.staticAccountKeys.findIndex(pubkey => pubkey.toBase58() === p.address);
                                if (balanceIndex !== -1) {
                                    const pre = tx.meta.preBalances[balanceIndex];
                                    const post = tx.meta.postBalances[balanceIndex];
                                    const receivedLamports = post - pre;
                                    const amountSOL = receivedLamports / 1e9;

                                    const priceRes = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
                                    const solPrice = priceRes.data.solana.usd;
                                    const amountInUSD = amountSOL * solPrice;

                                    // SÉCURITÉ : Minimum 90% du prix (marge pour les fees et volatilité)
                                    if (amountInUSD >= (usd * 0.90)) {
                                        check = { received: true, signature: sigInfo.signature };
                                    }
                                }
                            }
                        }
                    }
                } catch(e) { console.error("Err SOL:", e.message); }
            }
            
            // --- DÉTECTION ETH / USDT ERC20 ---
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
                            if (Number(tx.timeStamp) * 1000 > sessions[id].created_at) {
                                let amountInUSD = 0;
                                if (isUSDT) {
                                    amountInUSD = Number(tx.value) / 1000000;
                                } else {
                                    const ethPriceRes = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
                                    amountInUSD = (Number(tx.value) / 1e18) * ethPriceRes.data.ethereum.usd;
                                }

                                if (amountInUSD >= (usd * 0.90)) {
                                    check = { received: true, signature: tx.hash };
                                }
                            }
                        }
                    }
                } catch(e) { console.error("Err ETH:", e.message); }
            }

            // --- LIVRAISON ---
            if (check.received) {
                p.paid = true;
                console.log(`Paiement validé pour ${usd}$ via ${m}. Envoi en cours...`);
                const delivery = await sendUSDT(p.wallet, p.total_tokens);
                if (delivery.success) {
                    p.usdt_sent = true;
                    p.usdt_tx_signature = delivery.signature;
                    if (callback) await callback(id, m, usd, p.wallet, delivery.signature);
                }
            }
        }
    }
}

module.exports = { checkPendingPayments };const axios = require("axios");
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
    for (const id in sessions) {
        for (const m in sessions[id].methods) {
            const p = sessions[id].methods[m];
            if (p.paid || p.expires_at < Date.now()) continue;

            const [usd] = p.pack.split('|').map(Number);
            let check = { received: false, signature: null };

            // --- DÉTECTION SOLANA (SOL / CARD) ---
            if (m === "SOL" || m === "CARD") {
                try {
                    const conn = new Connection(SOLANA_RPC, "confirmed");
                    const sigs = await conn.getSignaturesForAddress(new PublicKey(p.address), { limit: 1 });
                    
                    if (sigs.length > 0) {
                        const sigInfo = sigs[0];
                        const txTime = sigInfo.blockTime * 1000;

                        if (txTime > sessions[id].created_at) {
                            // On récupère la transaction avec le support complet des versions
                            const tx = await conn.getTransaction(sigInfo.signature, {
                                maxSupportedTransactionVersion: 0,
                                commitment: "confirmed"
                            });

                            if (tx) {
                                // Calcul automatique du montant reçu sur l'adresse de paiement
                                const balanceIndex = tx.transaction.message.staticAccountKeys.findIndex(pubkey => pubkey.toBase58() === p.address);
                                if (balanceIndex !== -1) {
                                    const pre = tx.meta.preBalances[balanceIndex];
                                    const post = tx.meta.postBalances[balanceIndex];
                                    const receivedLamports = post - pre;
                                    const amountSOL = receivedLamports / 1e9;

                                    const priceRes = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
                                    const solPrice = priceRes.data.solana.usd;
                                    const amountInUSD = amountSOL * solPrice;

                                    // SÉCURITÉ : Minimum 90% du prix (marge pour les fees et volatilité)
                                    if (amountInUSD >= (usd * 0.90)) {
                                        check = { received: true, signature: sigInfo.signature };
                                    }
                                }
                            }
                        }
                    }
                } catch(e) { console.error("Err SOL:", e.message); }
            }
            
            // --- DÉTECTION ETH / USDT ERC20 ---
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
                            if (Number(tx.timeStamp) * 1000 > sessions[id].created_at) {
                                let amountInUSD = 0;
                                if (isUSDT) {
                                    amountInUSD = Number(tx.value) / 1000000;
                                } else {
                                    const ethPriceRes = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
                                    amountInUSD = (Number(tx.value) / 1e18) * ethPriceRes.data.ethereum.usd;
                                }

                                if (amountInUSD >= (usd * 0.90)) {
                                    check = { received: true, signature: tx.hash };
                                }
                            }
                        }
                    }
                } catch(e) { console.error("Err ETH:", e.message); }
            }

            // --- LIVRAISON ---
            if (check.received) {
                p.paid = true;
                console.log(`Paiement validé pour ${usd}$ via ${m}. Envoi en cours...`);
                const delivery = await sendUSDT(p.wallet, p.total_tokens);
                if (delivery.success) {
                    p.usdt_sent = true;
                    p.usdt_tx_signature = delivery.signature;
                    if (callback) await callback(id, m, usd, p.wallet, delivery.signature);
                }
            }
        }
    }
}

module.exports = { checkPendingPayments };