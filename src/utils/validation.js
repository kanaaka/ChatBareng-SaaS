const { body } = require('express-validator')

const loginValidation = [
  body('username').trim().notEmpty().withMessage('Username required'),
  body('password').notEmpty().withMessage('Password required'),
]

// v0.5.0 — role 'relay' (label UI "Cabang") ditambahkan; internal value tetap 'relay'
const createUserValidation = [
  body('username').trim().isLength({ min: 3, max: 30 }).withMessage('Username must be 3-30 chars'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 chars'),
  body('role').isIn(['admin', 'cs', 'relay']).withMessage('Role must be admin, cs, or relay'),
]

const updateUserValidation = [
  body('role').optional().isIn(['admin', 'cs', 'relay']),
  body('status').optional().isIn(['active', 'inactive']),
  body('password').optional().isLength({ min: 6 }),
]

const replyValidation = [
  body('content').trim().notEmpty().withMessage('Message content required'),
]

const purgeValidation = [
  body('mode').isIn(['soft', 'hard']).withMessage('Mode must be soft or hard'),
  body('chatIds').optional().isArray(),
  body('dateRange').optional().isObject(),
  body('reason').optional().isString(),
]

module.exports = {
  loginValidation,
  createUserValidation,
  updateUserValidation,
  replyValidation,
  purgeValidation,
}