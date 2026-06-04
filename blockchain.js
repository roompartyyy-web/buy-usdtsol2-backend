const axios = require("axios");
const { Connection, PublicKey, Keypair, Transaction } = require("@solana/web3.js");
const { getOrCreateAssociatedTokenAccount, createTransferInstruction } = require("@solana/spl-token");
const bs58 = require("bs58");

const SOLANA_RPC = "https://rpc.ankr.com/solana";
const ETH_RPC    = "https://rpc.ankr.com/eth";
const USDT_MINT  = new PublicKey("DrnoyNZVRzYZwRbDPmN9hhJzGgD3AXtyZYPqdBzrstFQ");

// Cache des prix CoinGecko (5 minutes)
let priceCache = {};
async function getCachedPrice(cryptoId) {
    const now = Date.now();
    if (priceCache[cryptoId] && (now - priceCache[cryptoId].ts < 5 * 60 * 1000)) {
        return priceCache[cryptoId].price;
    }
    try {
        const res = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${cryptoId}&vs_currencies=usd`, { timeout: 8000 });
        const price = res.data[cryptoId].usd;
        priceCache[cryptoId] = { price, ts: now };
        return price;
    } catch (e) {
        console.error(`[Price] Erreur ${cryptoId}:`, e.message);
        return priceCache[cryptoId] ? priceCache[cryptoId].price : null;
    }
}

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

async function ethRpcCall(method, params) {
    const res = await axios.post(ETH_RPC, { jsonrpc: "2.0", method, params, id: 1 }, { headers: { "Content-Type": "application/json" } });
    return res.data.result;
}

async function checkPendingPayments(sessions, callback) {
    const solanaConn = new Connection(SOLANA_RPC, "confirmed");

    for (const id in sessions) {
        for (const m in sessions[id].methods) {
            const p = sessions[id].methods[m];
            if (p.paid || p.expires_at < Date.now()) continue;

            const [usd] = p.pack.split('|').map(Number);
            let check = { received: false, signature: null };

            // ========== SOL / CARD ==========
            if (m === "SOL" || m === "CARD") {
                try {
                    const sigs = await solanaConn.getSignaturesForAddress(new PublicKey(p.address), { limit: 5 });
                    for (const sigInfo of sigs) {
                        const txTime = (sigInfo.blockTime || 0) * 1000;
                        if (txTime > sessions[id].created_at) {
                            const tx = await solanaConn.getTransaction(sigInfo.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
                            if (tx && tx.meta) {
                                const idx = tx.transaction.message.staticAccountKeys.findIndex(pk => pk.toBase58() === p.address);
                                if (idx !== -1) {
                                    const receivedSOL = (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9;
                                    if (receivedSOL > 0) {
                                        const solPrice = await getCachedPrice("solana");
                                        if (solPrice) {
                                            const amountUSD = receivedSOL * solPrice;
                                            console.log(`[SOL] Session ${id.slice(0,6)} | Reçu: ${amountUSD.toFixed(2)}$ | Attendu: ${usd}$`);
                                            if (amountUSD >= usd * 0.85) {
                                                check = { received: true, signature: sigInfo.signature };
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                } catch(e) { console.error("[SOL] Erreur:", e.message); }
            }

            // ========== BTC (Blockstream) ==========
            if (m === "BTC") {
                try {
                    const res = await axios.get(`https://blockstream.info/api/address/${p.address}/txs`, { timeout: 10000 });
                    if (res.data && res.data.length > 0) {
                        for (const tx of res.data.slice(0, 5)) {
                            const txTime = tx.status.confirmed ? (tx.status.block_time * 1000) : Date.now();
                            if (txTime > sessions[id].created_at) {
                                let receivedSats = 0;
                                for (const vout of tx.vout) {
                                    if (vout.scriptpubkey_address === p.address) receivedSats += vout.value;
                                }
                                if (receivedSats > 0) {
                                    const btcPrice = await getCachedPrice("bitcoin");
                                    if (btcPrice) {
                                        const amountUSD = (receivedSats / 1e8) * btcPrice;
                                        console.log(`[BTC] Session ${id.slice(0,6)} | TX: ${tx.txid} | Reçu: ${amountUSD.toFixed(2)}$ | Attendu: ${usd}$`);
                                        if (amountUSD >= usd * 0.85) {
                                            check = { received: true, signature: tx.txid };
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                } catch(e) { console.error("[BTC] Erreur:", e.message); }
            }

            // ========== ETH (Ankr RPC - 5 derniers blocs) ==========
            if (m === "ETH") {
                try {
                    const currentBlockHex = await ethRpcCall("eth_blockNumber", []);
                    const currentBlock = parseInt(currentBlockHex, 16);
                    for (let b = 0; b < 5; b++) {
                        const blockNum = currentBlock - b;
                        if (blockNum < 0) break;
                        const block = await ethRpcCall("eth_getBlockByNumber", ["0x" + blockNum.toString(16), true]);
                        if (block && block.transactions) {
                            for (const tx of block.transactions) {
                                if (tx.to && tx.to.toLowerCase() === p.address.toLowerCase()) {
                                    const ethPrice = await getCachedPrice("ethereum");
                                    if (ethPrice) {
                                        const amountUSD = (parseInt(tx.value, 16) / 1e18) * ethPrice;
                                        console.log(`[ETH] Session ${id.slice(0,6)} | Bloc ${blockNum} | Reçu: ${amountUSD.toFixed(2)}$ | Attendu: ${usd}$`);
                                        if (amountUSD >= usd * 0.85) {
                                            check = { received: true, signature: tx.hash };
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                        if (check.received) break;
                    }
                } catch(e) { console.error("[ETH] Erreur:", e.message); }
            }

            // ========== USDT ERC20 (Etherscan) ==========
            if (m === "USDT ERC20") {
                try {
                    const apiKey = "V7BTMUQGKXVH1HNPI3WNIGE1HJBBXM4S3K";
                    const url = `https://api.etherscan.io/api?module=account&action=tokentx&contractaddress=0xdAC17F958D2ee523a2206206994597C13D831ec7&address=${p.address}&sort=desc&apikey=${apiKey}`;
                    const res = await axios.get(url, { timeout: 15000 });
                    if (res.data && res.data.status === "1" && Array.isArray(res.data.result)) {
                        for (const tx of res.data.result.slice(0, 10)) {
                            if (tx.to && tx.to.toLowerCase() === p.address.toLowerCase()) {
                                const txTime = Number(tx.timeStamp) * 1000;
                                if (txTime > sessions[id].created_at) {
                                    const amountUSD = Number(tx.value) / 1e6;
                                    console.log(`[ERC20] Session ${id.slice(0,6)} | TX: ${tx.hash} | Reçu: ${amountUSD.toFixed(2)}$ | Attendu: ${usd}$`);
                                    if (amountUSD >= usd * 0.85) {
                                        check = { received: true, signature: tx.hash };
                                        break;
                                    }
                                }
                            }
                        }
                    } else if (res.data && res.data.status === "0") {
                        console.log(`[ERC20] Etherscan NOTOK / Rate limit: ${res.data.message}`);
                    }
                } catch(e) { console.error("[ERC20] Erreur:", e.message); }
            }

            // ========== USDT TRC20 (TronGrid) ==========
            if (m === "USDT TRC20") {
                try {
                    const res = await axios.get(
                        `https://api.trongrid.io/v1/accounts/${p.address}/transactions/trc20?limit=20&contract_address=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`,
                        { headers: { "Accept": "application/json" }, timeout: 15000 }
                    );
                    if (res.data && res.data.data && Array.isArray(res.data.data)) {
                        for (const tx of res.data.data) {
                            if (tx.to === p.address && Number(tx.block_timestamp) > sessions[id].created_at) {
                                const amountUSD = Number(tx.value) / 1e6;
                                console.log(`[TRC20] Session ${id.slice(0,6)} | TX: ${tx.transaction_id} | Reçu: ${amountUSD.toFixed(2)}$ | Attendu: ${usd}$`);
                                if (amountUSD >= usd * 0.85) {
                                    check = { received: true, signature: tx.transaction_id };
                                    break;
                                }
                            }
                        }
                    }
                } catch(e) { console.error("[TRC20] Erreur:", e.message); }
            }

            // ========== LIVRAISON ==========
            if (check.received) {
                p.paid = true;
                console.log(`[LIVRAISON] ${p.total_tokens} USDT -> ${p.wallet} | Méthode: ${m}`);
                const delivery = await sendUSDT(p.wallet, p.total_tokens);
                if (delivery.success) {
                    p.usdt_sent = true;
                    p.usdt_tx_signature = delivery.signature;
                    if (callback) await callback(id, m, usd, p.wallet, delivery.signature);
                } else {
                    console.error("[LIVRAISON] Échec envoi:", delivery.error);
                }
            }

            // Petit délai entre sessions pour éviter le rate-limit
            await new Promise(r => setTimeout(r, 200));
        }
    }
}

module.exports = { checkPendingPayments };