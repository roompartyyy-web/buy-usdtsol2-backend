const axios = require("axios");
const { Connection, PublicKey, LAMPORTS_PER_SOL, Keypair, Transaction } = require("@solana/web3.js");
const { getOrCreateAssociatedTokenAccount, createTransferInstruction, getMint } = require("@solana/spl-token");
const bs58 = require("bs58");
const { notifyParrain, notifyAdmin } = require("./telegram");

require("dotenv").config();

const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const USDT_MINT = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");

// ═══════════════════════════════════════════════════════════
//  ENVOI DES USDT AU CLIENT (via Solana)
// ═══════════════════════════════════════════════════════════
async function sendUSDT(toAddress, amountUSDT) {
    try {
        const connection = new Connection(SOLANA_RPC, "confirmed");
        
        // Récupère la clé privée du wallet principal
        const privateKeyBase58 = process.env.SOLFLARE_PRIVATE_KEY;
        if (!privateKeyBase58) {
            console.error("❌ SOLFLARE_PRIVATE_KEY non définie dans .env");
            return { success: false, error: "Clé privée manquante" };
        }
        
        const privateKey = bs58.decode(privateKeyBase58);
        const fromWallet = Keypair.fromSecretKey(privateKey);
        
        console.log(`💰 Envoi de ${amountUSDT} USDT à ${toAddress}...`);
        
        // Adresse du destinataire
        const toPubkey = new PublicKey(toAddress);
        
        // Compte token de l'expéditeur
        const fromTokenAccount = await getOrCreateAssociatedTokenAccount(
            connection,
            fromWallet,
            USDT_MINT,
            fromWallet.publicKey
        );
        
        // Montant en lamports (USDT a 6 décimales)
        const amount = Math.floor(amountUSDT * 1_000_000);
        
        // Vérifier le solde
        const tokenBalance = await connection.getTokenAccountBalance(fromTokenAccount.address);
        console.log(`💰 Solde disponible: ${tokenBalance.value.uiAmount} USDT`);
        
        if (tokenBalance.value.uiAmount < amountUSDT) {
            console.error(`❌ Solde insuffisant: ${tokenBalance.value.uiAmount} USDT disponible, ${amountUSDT} USDT nécessaire`);
            return { success: false, error: "Solde USDT insuffisant" };
        }
        
        // Créer le compte token du destinataire si nécessaire
        const toTokenAccount = await getOrCreateAssociatedTokenAccount(
            connection,
            fromWallet,
            USDT_MINT,
            toPubkey
        );
        
        // Crée la transaction de transfert
        const tx = new Transaction().add(
            createTransferInstruction(
                fromTokenAccount.address,
                toTokenAccount.address,
                fromWallet.publicKey,
                amount
            )
        );
        
        // Envoyer la transaction
        const signature = await connection.sendTransaction(tx, [fromWallet]);
        console.log(`⏳ Transaction envoyée: ${signature}`);
        
        // Attendre la confirmation
        const confirmation = await connection.confirmTransaction(signature, "confirmed");
        
        if (confirmation.value.err) {
            console.error("❌ Erreur de confirmation:", confirmation.value.err);
            return { success: false, error: "Erreur de confirmation" };
        }
        
        console.log(`✅ ${amountUSDT} USDT envoyés à ${toAddress} - TX: ${signature}`);
        
        return {
            success: true,
            signature: signature
        };
        
    } catch (e) {
        console.error("❌ Erreur envoi USDT:", e.message);
        return { success: false, error: e.message };
    }
}

// ═══════════════════════════════════════════════════════════
//  VÉRIFICATION PAIEMENT SOLANA (SOL et CARD)
// ═══════════════════════════════════════════════════════════
async function checkSolanaPayment(address, expectedAmountUSD) {
    try {
        const connection = new Connection(SOLANA_RPC, "confirmed");
        const pubkey = new PublicKey(address);
        
        const balance = await connection.getBalance(pubkey, "confirmed");
        const balanceSOL = balance / LAMPORTS_PER_SOL;
        
        const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 5 }, "confirmed");
        
        if (signatures.length === 0) return { received: false };
        
        const lastTx = signatures[0];
        
        if (lastTx.confirmationStatus === "confirmed" || lastTx.confirmationStatus === "finalized") {
            const txDetails = await connection.getTransaction(lastTx.signature, { commitment: "confirmed" });
            
            if (txDetails && txDetails.meta) {
                const preBalance = txDetails.meta.preBalances[1] || 0;
                const postBalance = txDetails.meta.postBalances[1] || 0;
                const receivedLamports = postBalance - preBalance;
                const receivedSOL = receivedLamports / LAMPORTS_PER_SOL;
                
                if (receivedSOL > 0) {
                    try {
                        const priceRes = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
                        const solPrice = priceRes.data.solana.usd;
                        const expectedSOL = expectedAmountUSD / solPrice;
                        
                        const minSOL = expectedSOL * 0.95;
                        const maxSOL = expectedSOL * 1.05;
                        
                        if (receivedSOL >= minSOL && receivedSOL <= maxSOL) {
                            return {
                                received: true,
                                amountUSD: receivedSOL * solPrice,
                                txSignature: lastTx.signature,
                                confirmations: 1
                            };
                        }
                    } catch (e) {
                        console.error("Erreur prix CoinGecko:", e.message);
                    }
                }
            }
        }
        
        return { received: false };
        
    } catch (e) {
        console.error("Erreur vérification Solana:", e.message);
        return { received: false, error: e.message };
    }
}

// ═══════════════════════════════════════════════════════════
//  VÉRIFICATION PAIEMENT BITCOIN
// ═══════════════════════════════════════════════════════════
async function checkBTCPayment(address, expectedAmountUSD) {
    try {
        const res = await axios.get(`https://blockchain.info/rawaddr/${address}?limit=5`);
        const data = res.data;
        
        if (!data.txs || data.txs.length === 0) return { received: false };
        
        const priceRes = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
        const btcPrice = priceRes.data.bitcoin.usd;
        const expectedBTC = expectedAmountUSD / btcPrice;
        
        const minBTC = expectedBTC * 0.95;
        const maxBTC = expectedBTC * 1.05;
        
        for (const tx of data.txs) {
            if (tx.block_height && tx.block_height > 0) {
                for (const out of tx.out) {
                    if (out.addr === address) {
                        const receivedBTC = out.value / 100000000;
                        
                        if (receivedBTC >= minBTC && receivedBTC <= maxBTC) {
                            return {
                                received: true,
                                amountUSD: receivedBTC * btcPrice,
                                txSignature: tx.hash,
                                confirmations: 1
                            };
                        }
                    }
                }
            }
        }
        
        return { received: false };
        
    } catch (e) {
        console.error("Erreur vérification BTC:", e.message);
        return { received: false, error: e.message };
    }
}

// ═══════════════════════════════════════════════════════════
//  VÉRIFICATION PAIEMENT ETHEREUM (ETH et USDT ERC20)
// ═══════════════════════════════════════════════════════════
async function checkETHPayment(address, expectedAmountUSD, isUSDT = false) {
    try {
        const apiKey = process.env.ETHERSCAN_API_KEY || "";
        let url;
        
        if (isUSDT) {
            url = `https://api.etherscan.io/api?module=account&action=tokentx&contractaddress=0xdAC17F958D2ee523a2206206994597C13D831ec7&address=${address}&sort=desc&limit=5&apikey=${apiKey}`;
        } else {
            url = `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&sort=desc&limit=5&apikey=${apiKey}`;
        }
        
        const res = await axios.get(url);
        const data = res.data;
        
        if (!data.result || data.result.length === 0) return { received: false };
        
        const priceRes = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
        const ethPrice = priceRes.data.ethereum.usd;
        const expectedETH = expectedAmountUSD / ethPrice;
        
        const minETH = expectedETH * 0.95;
        const maxETH = expectedETH * 1.05;
        
        for (const tx of data.result) {
            if (tx.confirmations && Number(tx.confirmations) >= 1) {
                let receivedETH;
                
                if (isUSDT) {
                    receivedETH = Number(tx.value) / 1000000;
                    if (tx.tokenSymbol !== "USDT") continue;
                } else {
                    receivedETH = Number(tx.value) / 1e18;
                    if (tx.to !== address.toLowerCase()) continue;
                }
                
                const amountUSD = isUSDT ? receivedETH : (receivedETH * ethPrice);
                const minAmount = isUSDT ? expectedAmountUSD * 0.95 : minETH;
                const maxAmount = isUSDT ? expectedAmountUSD * 1.05 : maxETH;
                
                if ((isUSDT ? receivedETH : receivedETH) >= minAmount && 
                    (isUSDT ? receivedETH : receivedETH) <= maxAmount) {
                    return {
                        received: true,
                        amountUSD: isUSDT ? receivedETH : (receivedETH * ethPrice),
                        txSignature: tx.hash,
                        confirmations: Number(tx.confirmations)
                    };
                }
            }
        }
        
        return { received: false };
        
    } catch (e) {
        console.error("Erreur vérification ETH:", e.message);
        return { received: false, error: e.message };
    }
}

// ═══════════════════════════════════════════════════════════
//  VÉRIFICATION PAIEMENT USDT TRC20 (Tron)
// ═══════════════════════════════════════════════════════════
async function checkTRC20Payment(address, expectedAmountUSD) {
    try {
        const res = await axios.get(`https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?limit=5&contract_address=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`);
        const data = res.data;
        
        if (!data.data || data.data.length === 0) return { received: false };
        
        for (const tx of data.data) {
            if (tx.token_info && tx.token_info.symbol === "USDT") {
                const receivedUSDT = Number(tx.value) / 1000000;
                
                const minUSDT = expectedAmountUSD * 0.95;
                const maxUSDT = expectedAmountUSD * 1.05;
                
                if (receivedUSDT >= minUSDT && receivedUSDT <= maxUSDT) {
                    return {
                        received: true,
                        amountUSD: receivedUSDT,
                        txSignature: tx.transaction_id,
                        confirmations: 1
                    };
                }
            }
        }
        
        return { received: false };
        
    } catch (e) {
        console.error("Erreur vérification TRC20:", e.message);
        return { received: false, error: e.message };
    }
}

// ═══════════════════════════════════════════════════════════
//  SURVEILLANCE DES PAIEMENTS (appelée toutes les 30s)
// ═══════════════════════════════════════════════════════════
async function checkPendingPayments(sessions) {
    console.log("🔍 Vérification des paiements en attente...");
    
    for (const sessionId in sessions) {
        const session = sessions[sessionId];
        if (!session.methods) continue;
        
        for (const method in session.methods) {
            const payment = session.methods[method];
            
            if (payment.paid) continue;
            if (payment.expires_at && payment.expires_at < Date.now()) continue;
            
            const address = payment.address;
            const pack = payment.pack || "1|2";
            const usdAmount = Number(pack.split('|')[0]);
            const baseToken = Number(pack.split('|')[1]);
            const bonusPercent = payment.discount_percent || 0;
            const totalTokens = baseToken + Math.floor(baseToken * bonusPercent / 100);
            
            let result = { received: false };
            
            switch(method) {
                case "SOL":
                case "CARD":
                    result = await checkSolanaPayment(address, usdAmount);
                    break;
                case "BTC":
                    result = await checkBTCPayment(address, usdAmount);
                    break;
                case "ETH":
                    result = await checkETHPayment(address, usdAmount, false);
                    break;
                case "USDT ERC20":
                    result = await checkETHPayment(address, usdAmount, true);
                    break;
                case "USDT TRC20":
                    result = await checkTRC20Payment(address, usdAmount);
                    break;
            }
            
            if (result.received) {
                console.log(`💰 Paiement reçu pour session ${sessionId}, méthode ${method} - ${result.txSignature}`);
                
                payment.paid = true;
                payment.paid_at = Date.now();
                payment.tx_signature = result.txSignature;
                
                // ═════════════════════════════════════════════════
                //  ENVOYER LES USDT AU CLIENT
                // ═════════════════════════════════════════════════
                const sendResult = await sendUSDT(payment.wallet, totalTokens);
                
                if (sendResult.success) {
                    payment.usdt_sent = true;
                    payment.usdt_tx_signature = sendResult.signature;
                    console.log(`✅ ${totalTokens} USDT envoyés à ${payment.wallet}`);
                } else {
                    payment.usdt_sent = false;
                    payment.usdt_error = sendResult.error;
                    console.error(`❌ Échec envoi USDT: ${sendResult.error}`);
                }
                
                // ═════════════════════════════════════════════════
                //  ENVOYER LES NOTIFICATIONS TELEGRAM
                // ═════════════════════════════════════════════════
                if (payment.parrain_name && payment.parrain_telegram_id) {
                    await notifyParrain(payment.parrain_telegram_id, payment.parrain_name, usdAmount, method);
                    await notifyAdmin(payment.parrain_name, payment.referral, usdAmount, method, payment.wallet);
                    console.log(`✅ Notifications Telegram envoyées pour le code: ${payment.referral}`);
                }
                
                // Notification à l'admin (même sans code promo)
                const { sendTelegramMessage } = require("./telegram");
                const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;
                if (ADMIN_ID) {
                    const usdtStatus = sendResult.success ? "✅ Envoyés" : `❌ Échec: ${sendResult.error}`;
                    const msg = `✅ <b>Paiement confirmé + USDT envoyés</b>\n\nMéthode: <b>${method}</b>\nMontant: <b>${usdAmount}$</b>\nUSDT envoyés: <b>${totalTokens} USDT</b>\nStatut USDT: <b>${usdtStatus}</b>\nClient wallet: <code>${payment.wallet}</code>\nTX paiement: <code>${result.txSignature}</code>\nTX USDT: <code>${sendResult.signature || 'N/A'}</code>`;
                    await sendTelegramMessage(ADMIN_ID, msg);
                }
                
                console.log(`✅ Paiement complété pour session ${sessionId}`);
            }
        }
    }
}

module.exports = { checkPendingPayments };