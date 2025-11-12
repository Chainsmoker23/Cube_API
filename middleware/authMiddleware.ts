import * as express from 'express';
import * as jwt from 'jsonwebtoken';

export const isAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: No token provided.' });
    }
    
    const token = authHeader.split(' ')[1];
    const jwtSecret = process.env.JWT_SECRET;

    if (!jwtSecret) {
        console.error("[Auth Middleware] JWT_SECRET is not configured.");
        return res.status(500).json({ error: "Internal server error: Auth system not configured." });
    }

    jwt.verify(token, jwtSecret, (err, decoded) => {
        if (err) {
            return res.status(403).json({ error: 'Forbidden: Invalid or expired token.' });
        }
        
        // You can add more checks here if needed, e.g., checking the role from the decoded payload
        const payload = decoded as { role?: string };
        if (payload.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden: You do not have permission to perform this action.' });
        }

        next();
    });
};