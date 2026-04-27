# ReNile OTP - WhatsApp Authentication Service

A robust, lightweight OTP (One-Time Password) service that uses WhatsApp as a delivery channel via the Evolution API. Built with Node.js and Express.

## 🚀 Features

- **OTP Delivery**: Sends 6-digit codes directly to user WhatsApp numbers.
- **Security**:
  - **Rate Limiting**: IP-based rate limiting to prevent spam.
  - **Brute-Force Protection**: Temporarily blocks phone numbers after multiple failed attempts.
  - **Request Limiting**: Blocks phone numbers after multiple OTP requests within a short window.
  - **Secure Comparison**: Uses `crypto.timingSafeEqual` to prevent timing attacks.
- **JWT Integration**: Issues a JSON Web Token (JWT) upon successful verification.
- **Sanitization**: Automatic phone number sanitization (special handling for Egyptian formats).
- **Garbage Collection**: In-memory store cleanup for expired codes and blocks.

## 🛠 Prerequisites

This service requires a running instance of the **Evolution API** to send WhatsApp messages.

- **Evolution API URL**: The endpoint of your Evolution API.
- **API Key**: Your Evolution API master/instance key.
- **Instance Name**: The name of the WhatsApp instance connected in Evolution API.

## 📦 Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd renile-evolution-otp
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file in the root directory:
   ```env
   PORT=4000
   JWT_SECRET=your_super_secret_key
   EVOLUTION_URL=https://your-evolution-api.com
   API_KEY=your_evolution_api_key
   INSTANCE_NAME=your_instance_name
   ```

## 🚦 Usage

### Start the server

```bash
# Production mode
npm start

# Development mode (with reload)
npm run dev
```

### API Endpoints

#### 1. Request OTP
Generates and sends a 6-digit code to the specified phone number.

- **URL**: `/api/login`
- **Method**: `POST`
- **Body**:
  ```json
  {
    "phone": "201012345678"
  }
  ```

#### 2. Verify OTP
Validates the code and returns a JWT.

- **URL**: `/api/verify`
- **Method**: `POST`
- **Body**:
  ```json
  {
    "phone": "201012345678",
    "code": "123456"
  }
  ```

## 📂 Project Structure

- `server.js`: Main entry point.
- `src/controllers/`: Route handlers (logic for login/verify).
- `src/services/`: External integrations (Evolution API).
- `src/middleware/`: Express middlewares (rate limiting).
- `src/helpers/`: Utility functions (security, sanitization, response formatting).

## 🛡 Security Notes

- **In-Memory Store**: This service uses an in-memory object to store OTPs and block status. Restarting the server will clear all active OTPs and blocks. For production use with multiple instances, consider using Redis.
- **Rate Limiting**: Default IP rate limit is 20 requests per 15 minutes.
- **Blocking**: Accounts are blocked for 1 hour after 3 failed attempts or 3 OTP requests.

---
Built for ReNile OTP Authentication.
