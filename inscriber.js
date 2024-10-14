// Required dependencies
const express = require('express');
const { exec } = require('child_process');
const bodyParser = require('body-parser');

// Initialize Express server
const app = express();
app.use(bodyParser.json());

// Watch list to store addresses and required amounts
let watchList = [];
let detectedTransactions = []; // Store detected transactions since server start
let startBlockHeight = null; // To store block height when server starts

// Helper function to run shell commands (for both bitcoin-cli and ord)
function runCommand(command, callback) {
    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error executing command: ${error.message}`);
            return callback(error, null);
        }
        if (stderr) {
            console.error(`Command error: ${stderr}`);
            return callback(new Error(stderr), null);
        }
        callback(null, stdout.trim());
    });
}

// Convert fee rate from BTC/KB to sats/vbyte (e.g., 0.00002003 BTC/KB -> 2 sats/vbyte)
function convertFeeRate(feeRateBtcPerKb) {
    const feeRateSatsPerVbyte = feeRateBtcPerKb * 100000000 / 1000;
    return Math.round(feeRateSatsPerVbyte); // Round to nearest integer
}

// Get the block height when the server starts (bitcoin-cli command)
function getCurrentBlockHeight() {
    return new Promise((resolve, reject) => {
        runCommand('bitcoin-cli -rpcwallet=spaceblocks getblockcount', (err, blockHeight) => {
            if (err) return reject(err);
            resolve(parseInt(blockHeight, 10)); // Convert block height to integer
        });
    });
}

// Endpoint to get current price of inscription (this would be a fixed or variable price)
app.get('/price', (req, res) => {
    const price = 0.001; // Example: 0.001 BTC for the inscription
    res.json({ price });
});

// Simplified /fee endpoint to return the fee in sats/vbyte
app.get('/fee', (req, res) => {
    runCommand('bitcoin-cli -rpcwallet=spaceblocks estimatesmartfee 6', (err, result) => {
        if (err) return res.status(500).send(err.message);

        const feeRateBtcPerKb = JSON.parse(result).feerate;
        const feeRateSatsPerVbyte = convertFeeRate(feeRateBtcPerKb);
        res.json({ feeRate: feeRateSatsPerVbyte });
    });
});

// Endpoint to view the current watchlist and status
app.get('/watchlist', (req, res) => {
    res.json({ watchList });
});

// Endpoint to view detected transactions since the server started
app.get('/transactions', (req, res) => {
    res.json({ detectedTransactions });
});

// Endpoint to generate a transaction request with address and amount using `ord wallet --name spaceblocks receive`
app.get('/transaction', (req, res) => {
    const amountRequired = 0.001; // Amount required for minting

    // Use ord command without bitcoin-cli
    runCommand('ord wallet --name spaceblocks receive', (err, result) => {
        if (err) return res.status(500).send(err.message);

        try {
            // Parse the output and extract the address
            const parsedResult = JSON.parse(result);
            const address = parsedResult.addresses[0]; // Extract the first address

            // Add the address, amount, and status to the watch list
            watchList.push({ address, amountRequired, status: 'pending' });

            res.json({ address, amount: amountRequired });
        } catch (parseError) {
            console.error(`Error parsing JSON: ${parseError.message}`);
            res.status(500).send('Error generating address.');
        }
    });
});

// Function to periodically check for transactions on all watched addresses
function checkTransactions() {
    console.log('Starting transaction check...');
    runCommand('bitcoin-cli -rpcwallet=spaceblocks listunspent', (err, utxos) => {
        if (err) {
            console.error('Error listing unspent UTXOs:', err.message);
            return;
        }

        const unspent = JSON.parse(utxos);
        console.log(`Number of UTXOs to check: ${unspent.length}`);

        // Filter UTXOs based on block height (after server start)
        unspent.forEach(utxo => {
            if (!utxo.blockhash) {
                // Skip UTXOs that don't have a blockhash (unconfirmed transactions)
                return;
            }

            // Get the block height of the UTXO
            runCommand(`bitcoin-cli -rpcwallet=spaceblocks getblock ${utxo.blockhash}`, (err, blockInfo) => {
                if (err) {
                    console.error(`Error fetching block info for blockhash ${utxo.blockhash}:`, err.message);
                    return;
                }

                const blockData = JSON.parse(blockInfo);
                const utxoBlockHeight = blockData.height;

                // Only process UTXOs created after the server start
                if (utxoBlockHeight >= startBlockHeight) {
                    console.log(`Processing UTXO for address ${utxo.address}, Block height: ${utxoBlockHeight}`);

                    // Iterate over each entry in the watchlist
                    watchList = watchList.map(watchEntry => {
                        const { address, amountRequired, status } = watchEntry;

                        if (utxo.address === address && utxo.amount >= amountRequired && status === 'pending') {
                            console.log(`Transaction detected for address ${address}, TXID: ${utxo.txid}`);

                            // Update the status of the watchEntry to "detected"
                            watchEntry.status = 'detected';

                            // Add the detected transaction to the detectedTransactions array
                            detectedTransactions.push({
                                address,
                                txid: utxo.txid,
                                amount: utxo.amount,
                                blockHeight: utxoBlockHeight
                            });

                            // Fetch the fee rate in sats/vbyte from the /fee endpoint
                            runCommand('bitcoin-cli -rpcwallet=spaceblocks estimatesmartfee 6', (err, result) => {
                                if (err) {
                                    console.error('Error fetching fee rate:', err.message);
                                    return;
                                }

                                const feeRateBtcPerKb = JSON.parse(result).feerate;
                                const feeRateSatsPerVbyte = convertFeeRate(feeRateBtcPerKb);

                                // Mint Bitbar using the correct fee rate
                                mintBitbar(address, feeRateSatsPerVbyte);
                            });
                        }

                        return watchEntry; // Keep the entry in the watchlist
                    });
                }
            });
        });

        console.log('Transaction check completed.');
    });
}

// Function to inscribe the 1KB SVG as a Bitbar Ordinal to the given address with dynamic fee-rate
function mintBitbar(address, feeRateSatsPerVbyte) {
    const svgPath = '1kB.svg'; // Path to the 1KB SVG file

    runCommand(`ord wallet --name spaceblocks inscribe --file ${svgPath} --destination ${address} --fee-rate ${feeRateSatsPerVbyte}`, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error inscribing Ordinal: ${error.message}`);
            return;
        }
        console.log(`Bitbar successfully inscribed for address ${address} with fee-rate ${feeRateSatsPerVbyte}. Details: ${stdout}`);
    });
}

// Start the server and capture block height
getCurrentBlockHeight()
    .then(blockHeight => {
        startBlockHeight = blockHeight;
        console.log(`Server started at block height: ${startBlockHeight}`);

        // Periodically check transactions every 30 seconds
        setInterval(checkTransactions, 30000);

        // Start the Express server
        const PORT = process.env.PORT || 3000;
        app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    })
    .catch(err => {
        console.error('Error getting current block height:', err.message);
    });
