const axios = require("axios");
const { Connection, PublicKey, Keypair, Transaction } = require("@solana/web3.js");
const { getOrCreateAssociatedTokenAccount, createTransferInstruction } = require("@solana/spl-token");
const bs58 = require("bs58");

const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const ETH_RPC = "https://rpc.ankr.com/eth";
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

// Appel RPC generique Ankr
async function ethRpcCall(method, params) {
    const res = await axios.post(ETH_RPC, {
        jsonrpc: "2.0", method, params, id: 1
    }, { headers: { "Content-Type": "application/json" } });
    return res.data.result;
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
                    if (sigs.length > 0 && (sigs[0].blockTime * 1000) > sessions[id].created_at) {
                        const tx = await conn.getTransaction(sigs[0].signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
                        if (tx) {
                            const idx = tx.transaction.message.staticAccountKeys.findIndex(pubkey => pubkey.toBase58() === p.address);
                            if (idx !== -1) {
                                const receivedSOL = (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9;
                                const price = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
                                const amountUSD = receivedSOL * price.data.solana.usd;
                                console.log(`[SOL] Recu: ${amountUSD.toFixed(2)}$ | Attendu: ${usd}$`);
                                if (amountUSD >= usd * 0.85) check = { received: true, signature: sigs[0].signature };
                            }
                        }
                    }
                } catch(e) { console.error("[Err SOL]", e.message); }
            }

            // ========== BTC (Blockstream) ==========
            if (m === "BTC") {
                try {
                    const res = await axios.get(`https://blockstream.info/api/address/${p.address}/txs`);
                    if (res.data && res.data.length > 0) {
                        for (const tx of res.data.slice(0, 5)) {
                            const txTime = tx.status.confirmed ? (tx.status.block_time * 1000) : Date.now();
                            if (txTime > sessions[id].created_at) {
                                let receivedSats = 0;
                                for (const vout of tx.vout) {
                                    if (vout.scriptpubkey_address === p.address) receivedSats += vout.value;
                                }
                                const receivedBTC = receivedSats / 1e8;
                                const price = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
                                const amountUSD = receivedBTC * price.data.bitcoin.usd;
                                console.log(`[BTC] TX: ${tx.txid} | Recu: ${amountUSD.toFixed(2)}$ | Attendu: ${usd}$`);
                                if (amountUSD >= usd * 0.85) {
                                    check = { received: true, signature: tx.txid };
                                    break;
                                }
                            }
                        }
                    }
                } catch(e) { console.error("[Err BTC]", e.message); }
            }

            // ========== ETH (Ankr RPC) ==========
            if (m === "ETH") {
                try {
                    const blockNumber = await ethRpcCall("eth_blockNumber", []);
                    const txs = await ethRpcCall("eth_getBlockByNumber", [blockNumber, true]);
                    if (txs && txs.transactions) {
                        for (const tx of txs.transactions) {
                            if (tx.to && tx.to.toLowerCase() === p.address.toLowerCase()) {
                                const txTime = Date.now(); // Block recent = maintenant
                                if (txTime > sessions[id].created_at) {
                                    const receivedETH = parseInt(tx.value, 16) / 1e18;
                                    const price = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
                                    const amountUSD = receivedETH * price.data.ethereum.usd;
                                    console.log(`[ETH] TX: ${tx.hash} | Recu: ${amountUSD.toFixed(2)}$ | Attendu: ${usd}$`);
                                    if (amountUSD >= usd * 0.85) {
                                        check = { received: true, signature: tx.hash };
                                        break;
                                    }
                                }
                            }
                        }
                    }
                } catch(e) { console.error("[Err ETH]", e.message); }
            }

            // ========== USDT ERC20 (Etherscan) ==========
            if (m === "USDT ERC20") {
                try {
                    const apiKey = "V7BTMUQGKXVH1HNPI3WNIGE1HJBBXM4S3K";
                    const url = `https://api.etherscan.io/api?module=account&action=tokentx&contractaddress=0xdAC17F958D2ee523a2206206994597C13D831ec7&address=${p.address}&sort=desc&apikey=${apiKey}`;
                    const res = await axios.get(url, { timeout: 10000 });
                    if (res.data && res.data.status === "1" && Array.isArray(res.data.result)) {
                        for (const tx of res.data.result.slice(0, 10)) {
                            if (tx.to && tx.to.toLowerCase() === p.address.toLowerCase()) {
                                const txTime = Number(tx.timeStamp) * 1000;
                                if (txTime > sessions[id].created_at) {
                                    const amountUSD = Number(tx.value) / 1e6;
                                    console.log(`[ERC20] TX: ${tx.hash} | Recu: ${amountUSD.toFixed(2)}$ | Attendu: ${usd}$`);
                                    if (amountUSD >= usd * 0.85) {
                                        check = { received: true, signature: tx.hash };
                                        break;
                                    }
                                }
                            }
                        }
                    }
                } catch(e) { console.error("[Err ERC20]", e.message); }
            }

            // ========== USDT TRC20 (TronGrid) ==========
            if (m === "USDT TRC20") {
                try {
                    const res = await axios.get(`https://api.trongrid.io/v1/accounts/${p.address}/transactions/trc20?limit=20&contract_address=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`, {
                        headers: { "Accept": "application/json" },
                        timeout: 10000
                    });
                    if (res.data && res.data.data && Array.isArray(res.data.data)) {
                        for (const tx of res.data.data) {
                            if (tx.to === p.address) {
                                const txTime = Number(tx.block_timestamp);
                                if (txTime > sessions[id].created_at) {
                                    const amountUSD = Number(tx.value) / 1e6;
                                    console.log(`[TRC20] TX: ${tx.transaction_id} | Recu: ${amountUSD.toFixed(2)}$ | Attendu: ${usd}$`);
                                    if (amountUSD >= usd * 0.85) {
                                        check = { received: true, signature: tx.transaction_id };
                                        break;
                                    }
                                }
                            }
                        }
                    }
                } catch(e) { console.error("[Err TRC20]", e.message); }
            }

            // ========== LIVRAISON ==========
            if (check.received) {
                p.paid = true;
                console.log(`[LIVRAISON] ${p.total_tokens} USDT -> ${p.wallet} | Methode: ${m}`);
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