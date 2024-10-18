// server.mjs

// Import environment variables
import dotenv from 'dotenv';
dotenv.config();

// Import necessary modules
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import peanut from '@squirrel-labs/peanut-sdk';
import { getDefaultProvider, Wallet, BigNumber, utils } from 'ethers';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';

// __dirname and __filename replacement in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express app
const app = express();
const port = process.env.PORT || 8001;

// Middleware to parse JSON bodies
app.use(express.json());

// Use morgan for HTTP request logging
app.use(morgan('combined'));

// Apply rate limiting to all requests
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: 'Too many requests from this IP, please try again after 15 minutes.'
});
app.use(limiter);

// Security Middleware: API Key Verification
const verifyApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey && apiKey === process.env.API_KEY) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized: Invalid or missing API key.' });
  }
};

// Configuration
const CHAIN_ID = process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID) : 11155111; // Sepolia ETH Testnet
const MNEMONIC = process.env.MNEMONIC;

// Validate Mnemonic
if (!MNEMONIC || MNEMONIC.trim().split(' ').length !== 12) {
  console.error('Invalid or missing MNEMONIC in environment variables.');
  process.exit(1);
}

// Initialize Wallet
const initializeWallet = async () => {
  try {
    // 1. Initialize provider with your API keys
    const provider = getDefaultProvider(CHAIN_ID, {
      infura: process.env.INFURA_PROJECT_ID, // For Infura
      etherscan: process.env.ETHERSCAN_API_KEY // For Etherscan
    });

    // 2. Verify provider connection
    const network = await provider.getNetwork();
    console.log(`Connected to network: ${network.name} (chainId: ${network.chainId})`);

    // 3. Create wallet from mnemonic and connect to provider
    const wallet = Wallet.fromMnemonic(MNEMONIC).connect(provider);
    console.log(`Wallet Address: ${wallet.address}`);

    // 4. Verify provider attached to wallet
    if (!wallet.provider) {
      throw new Error('Provider not attached to the wallet.');
    }

    return wallet;
  } catch (error) {
    console.error('Failed to initialize wallet:', error);
    process.exit(1);
  }
};

// Initialize wallet with top-level await
const wallet = await initializeWallet();

// Health Check Endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'Server is running.' });
});

// Endpoint to create a Peanut Link using the new method
app.post('/create-link', verifyApiKey, async (req, res) => {
  try {
    const { amount, tokenType } = req.body;

    // Validate 'amount'
    if (typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ error: 'Invalid or missing "amount" in request body.' });
    }

    // Validate 'tokenType'
    const validTokenTypes = [0, 1, 2, 3];
    const token_Type = tokenType !== undefined ? tokenType : 0; // Default to 0 (Ether)
    if (!validTokenTypes.includes(token_Type)) {
      return res.status(400).json({ error: `Invalid "tokenType". Valid types are ${validTokenTypes.join(', ')}.` });
    }

    // Log request details
    console.log(`Received request to create link: amount=${amount}, tokenType=${token_Type}`);

    const tokenDecimals = 9; // Adjust if needed based on token type

    // Define link details with accurate tokenAmount
    const tokenAmount = utils.parseUnits(amount.toString(), tokenDecimals); // Accurate conversion

    const linkDetails = {
      chainId: CHAIN_ID,
      tokenAmount: tokenAmount, // Use the BigNumber directly
      tokenType: token_Type, // 0 for Ether, 1 for ERC20, etc.
      tokenDecimals: tokenDecimals // Adjust decimals based on token type if necessary
    };

    console.log(`tokenAmount: ${tokenAmount.toString()}`); // Verify tokenAmount

    // Generate a random password for the link
    const password = await peanut.getRandomString(16);

    // Prepare deposit transactions
    const preparedTransactions = await peanut.prepareDepositTxs({
      address: wallet.address,
      linkDetails,
      passwords: [password]
    });

    if (!preparedTransactions || !preparedTransactions.unsignedTxs || preparedTransactions.unsignedTxs.length === 0) {
      console.error('Failed to prepare deposit transactions.');
      return res.status(500).json({ error: 'Failed to prepare deposit transactions.' });
    }

    // Initialize an array to store transaction hashes
    const transactionHashes = [];

    // Sign and send each prepared transaction
    for (const unsignedTx of preparedTransactions.unsignedTxs) {
      // Convert Peanut SDK transaction to Ethers.js v5 transaction format
      const convertedTx = peanut.peanutToEthersV5Tx(unsignedTx);

      // Ensure 'value' is a BigNumber
      if (!BigNumber.isBigNumber(convertedTx.value)) {
        throw new Error('Transaction "value" must be a BigNumber.');
      }

      // Optional: Log transaction details before sending
      console.log('Sending Transaction:', {
        from: convertedTx.from, // This might be undefined; Ethers.js infers it from the wallet
        to: convertedTx.to,
        value: utils.formatEther(convertedTx.value),
        gasLimit: convertedTx.gasLimit ? convertedTx.gasLimit.toString() : 'Not Specified',
        gasPrice: convertedTx.gasPrice ? utils.formatUnits(convertedTx.gasPrice, 'gwei') : 'Not Specified',
        data: convertedTx.data
      });

      // Send the transaction
      const signedTx = await wallet.sendTransaction(convertedTx);

      // Push the transaction hash to the array
      transactionHashes.push(signedTx.hash);

      console.log(`Signed and sent transaction: ${signedTx.hash}`);
    }

    // Retrieve the link using the last transaction hash
    const { links } = await peanut.getLinksFromTx({
      linkDetails,
      passwords: [password],
      txHash: transactionHashes[transactionHashes.length - 1]
    });

    if (!links || links.length === 0) {
      console.error('Failed to retrieve links from transaction.');
      return res.status(500).json({ error: 'Failed to retrieve links from transaction.' });
    }

    const generatedLink = links[0];

    console.log(`Generated Peanut Link: ${generatedLink}`);

    // Send the link as a JSON response
    res.status(200).json({ link: generatedLink, txHashes: transactionHashes });
  } catch (error) {
    console.error('Error creating Peanut Link:', error);

    // Specific error handling
    if (error.code === 'INSUFFICIENT_FUNDS') {
      return res.status(400).json({ error: 'Insufficient funds in the wallet to complete the transaction.' });
    }

    // Handle other specific errors as needed

    res.status(500).json({ error: 'Failed to create Peanut Link.' });
  }
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled Error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

// Start the server
app.listen(port, () => {
  console.log(`Express server listening at http://localhost:${port}`);
});
