import { Router } from 'express';
import { leaderboardController } from '../controllers/leaderboard';

const router = Router();

/**
 * @route   POST /api/leaderboards
 * @desc    Create a new leaderboard
 * @access  Public
 */
router.post('/', (req, res) => leaderboardController.create(req, res));

/**
 * @route   GET /api/leaderboards
 * @desc    Get all leaderboards
 * @access  Public
 */
router.get('/', (req, res) => leaderboardController.getAll(req, res));

/**
 * @route   GET /api/leaderboards/:id
 * @desc    Get leaderboard by ID
 * @access  Public
 */
router.get('/:id', (req, res) => leaderboardController.getById(req, res));

/**
 * @route   PUT /api/leaderboards/:id
 * @desc    Update leaderboard by ID
 * @access  Public
 */
router.put('/:id', (req, res) => leaderboardController.update(req, res));

/**
 * @route   DELETE /api/leaderboards/:id
 * @desc    Delete leaderboard by ID
 * @access  Public
 */
router.delete('/:id', (req, res) => leaderboardController.delete(req, res));

/**
 * @route   GET /api/leaderboards/person/:personId
 * @desc    Get all leaderboards for a specific person
 * @access  Public
 */
router.get('/person/:personId', (req, res) => leaderboardController.getByPersonId(req, res));

export default router;
