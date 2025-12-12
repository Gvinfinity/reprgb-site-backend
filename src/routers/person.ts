import { Router } from 'express';
import { personController } from '../controllers/person';

const router = Router();

/**
 * @route   POST /api/people
 * @desc    Create a new person
 * @access  Public
 */
router.post('/', (req, res) => personController.create(req, res));

/**
 * @route   GET /api/people
 * @desc    Get all people
 * @access  Public
 */
router.get('/', (req, res) => personController.getAll(req, res));

/**
 * @route   GET /api/people/:id
 * @desc    Get person by ID
 * @access  Public
 */
router.get('/:id', (req, res) => personController.getById(req, res));

/**
 * @route   PUT /api/people/:id
 * @desc    Update person by ID
 * @access  Public
 */
router.put('/:id', (req, res) => personController.update(req, res));

/**
 * @route   DELETE /api/people/:id
 * @desc    Delete person by ID
 * @access  Public
 */
router.delete('/:id', (req, res) => personController.delete(req, res));

export default router;
