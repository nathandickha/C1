import express from 'express';
import cors from 'cors';
import nodemailer from 'nodemailer';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Serve frontend
app.use(express.static(path.join(__dirname, '../frontend')));

// Store submissions temporarily
let submissions = [];

// API to submit a pool design
app.post('/api/submit', async (req, res) => {
  try {
    const data = req.body;
    submissions.push(data);

    // Configure your email transport
    let transporter = nodemailer.createTransport({
      host: "smtp.example.com",
      port: 587,
      secure: false, // true for 465
      auth: { user: "your@email.com", pass: "password" }
    });

    await transporter.sendMail({
      from: '"Pool Designer" <no-reply@poolapp.com>',
      to: "nathandickha@gmail.com",  // <-- replace with your desired recipient
      subject: "New Pool Design Submitted",
      text: `A new pool design was submitted: ${JSON.stringify(data, null, 2)}`
    });

    res.json({ message: 'Design submitted successfully!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to submit design.' });
  }
});

// API to view submissions
app.get('/api/submissions', (req, res) => {
  res.json(submissions);
});

// Catch-all to serve index.html for SPA routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Start server
const PORT = 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
