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

            // ========== SOL / CARD ==========
            if (m === "SOL" || m === "CARD") {
                try {
                    const conn = new Connection(SOLANA_RPC, "confirmed");
                    const sigs = await conn.getSignaturesForAddress(new PublicKey(p.address), { limit: 1 });
                    if (sigs.length > 0) {
                        const txTime = sigs[0].blockTime * 1000;
                        if (txTime > sessions[id].created_at) {
                            const tx = await conn.getTransaction(sigs[0].signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
                            if (tx) {
                                const balanceIndex = tx.transaction.message.staticAccountKeys.findIndex(pubkey => pubkey.toBase58() === p.address);
                                if (balanceIndex !== -1) {
                                    const receivedLamports = tx.meta.postBalances[balanceIndex] - tx.meta.preBalances[balanceIndex];
                                    const amountSOL = receivedLamports / 1e9;
                                    const priceRes = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
                                    const amountInUSD = amountSOL * priceRes.data.solana.usd;
                                    console.log(`[SOL] Reçu: ${amountInUSD}$ | Attendu: ${usd}$`);
                                    if (amountInUSD >= (usd * 0.90)) check = { received: true, signature: sigs[0].signature };
                                }
                            }
                        }
                    }
                } catch(e) { console.error("[Err SOL]", e.message); }
            }

            // ========== BTC ==========
            if (m === "BTC") {
                try {
                    const res = await axios.get(`https://blockstream.info/api/address/${p.address}/txs`);
                    if (res.data && Array.isArray(res.data) && res.data.length > 0) {
                        // On boucle sur les transactions récentes
                        for (const tx of res.data.slice(0, 5)) {
                            const txTime = (tx.status.block_time || 0) * 1000;
                            if (txTime > sessions[id].created_at) {
                                let receivedSats = 0;
                                for (const vout of tx.vout) {
                                    if (vout.scriptpubkey_address === p.address) receivedSats += vout.value;
                                }
                                const receivedBTC = receivedSats / 100000000;
                                const priceRes = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
                                const amountInUSD = receivedBTC * priceRes.data.bitcoin.usd;
                                console.log(`[BTC] TX: ${tx.txid} | Reçu: ${amountInUSD}$ | Attendu: ${usd}$`);
                                if (amountInUSD >= (usd * 0.90)) {
                                    check = { received: true, signature: tx.txid };
                                    break;
                                }
                            }
                        }
                    }
                } catch(e) { console.error("[Err BTC]", e.message); }
            }

            // ========== ETH / USDT ERC20 ==========
            if (m === "ETH" || m === "USDT ERC20") {
                try {
                    const isUSDT = m === "USDT ERC20";
                    const apiKey = "V7BTMUQGKXVH1HNPI3WNIGE1HJBBXM4S3K";
                    const url = isUSDT
                        ? `https://api.etherscan.io/api?module=account&action=tokentx&contractaddress=0xdAC17F958D2ee523a2206206994597C13D831ec7&address=${p.address}&sort=desc&apikey=${apiKey}`
                        : `https://api.etherscan.io/api?module=account&action=txlist&address=${p.address}&sort=desc&apikey=${apiKey}`;
                    
                    const res = await axios.get(url);
                    if (res.data.status === "1" && Array.isArray(res.data.result)) {
                        // On boucle sur les 10 dernières transactions pour trouver la bonne
                        for (const tx of res.data.result.slice(0, 10)) {
                            if (tx.to && tx.to.toLowerCase() === p.address.toLowerCase()) {
                                const txTime = Number(tx.timeStamp) * 1000;
                                if (txTime > sessions[id].created_at) {
                                    let amountInUSD = 0;
                                    if (isUSDT) {
                                        amountInUSD = Number(tx.value) / 1000000;
                                    } else {
                                        const priceRes = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
                                        amountInUSD = (Number(tx.value) / 1e18) * priceRes.data.ethereum.usd;
                                    }
                                    console.log(`[${m}] TX: ${tx.hash || tx.transactionHash} | Reçu: ${amountInUSD}$ | Attendu: ${usd}$`);
                                    if (amountInUSD >= (usd * 0.90)) {
                                        check = { received: true, signature: tx.hash };
                                        break;
                                    }
                                }
                            }
                        }
                    } else {
                        console.log(`[${m}] Etherscan erreur:`, res.data.message || "Résultat invalide");
                    }
                } catch(e) { console.error(`[Err ${m}]`, e.message); }
            }

            // ========== USDT TRC20 ==========
            if (m === "USDT TRC20") {
                try {
                    const res = await axios.get(`https://apilist.tronscanapi.com/api/token_trc20/transfers?limit=20&start=0&sort=-timestamp&relatedAddress=${p.address}&contract_address=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`);
                    if (res.data && res.data.token_transfers && Array.isArray(res.data.token_transfers)) {
                        for (const tx of res.data.token_transfers) {
                            if (tx.to_address === p.address) {
                                const txTime = Number(tx.block_ts);
                                if (txTime > sessions[id].created_at) {
                                    const amountInUSD = Number(tx.quant) / 1000000;
                                    console.log(`[TRC20] TX: ${tx.transaction_id} | Reçu: ${amountInUSD}$ | Attendu: ${usd}$`);
                                    if (amountInUSD >= (usd * 0.90)) {
                                        check = { received: true, signature: tx.transaction_id };
                                        break;
                                    }
                                }
                            }
                        }
                    }
                } catch(e) { console.error("[Err TRC20]", e.message); }
            }

            // ========== ENVOI DES TOKENS ==========
            if (check.received) {
                p.paid = true;
                console.log(`[LIVRAISON] Envoi de ${p.total_tokens} USDT vers ${p.wallet}`);
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