import { scrapeUrl } from './scraper.js';
import {
  saveTopic, listTopics, getTopic,
  saveQuestions, getQuestions,
  recordAttempt, getTopicProgress,
  createCourse, listCourses, getCourse,
  addTopicToCourse
} from '../db/sqlite.js';

export const toolDefinitions = [
  {
    name: 'scrape_url',
    description: 'Fetches a webpage and extracts its readable text, for ingesting as study material.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url']
    }
  },
  {
    name: 'save_topic',
    description:
      'Saves study material as a named topic. Call after receiving content from any source. ' +
      'Name it clearly based on the subject matter (e.g. "Photosynthesis", "WW2 Causes").',
    input_schema: {
      type: 'object',
      properties: {
        name:      { type: 'string' },
        content:   { type: 'string' },
        source:    { type: 'string', enum: ['paste', 'url', 'file'] },
        sourceRef: { type: 'string', description: 'URL or filename if applicable' }
      },
      required: ['name', 'content', 'source']
    }
  },
  {
    name: 'list_topics',
    description: 'Lists all saved study topics with progress stats.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_topic',
    description:
      'Retrieves the full content of a topic. Always call this before explaining, ' +
      'quizzing, or making flashcards — work from their material, not your own knowledge.',
    input_schema: {
      type: 'object',
      properties: { topicId: { type: 'string' } },
      required: ['topicId']
    }
  },
  {
    name: 'save_questions',
    description:
      'Saves a batch of generated questions or flashcards for a topic. ' +
      'Call BEFORE presenting questions to the user — the returned IDs are needed to record attempts. ' +
      'Generate exactly as many as the user asked for — if they gave no count, default to 10. ' +
      'If that number is large, split across multiple calls rather than truncating the batch. ' +
      'For quizzes, default to type "mcq" with exactly 4 options each — ' +
      'this lets answers be graded locally without an extra API call per question. Use "short" for ' +
      'brief free-text answer questions, and "flashcard" for flashcard decks.',
    input_schema: {
      type: 'object',
      properties: {
        topicId: { type: 'string' },
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              answer:   { type: 'string' },
              type:     { type: 'string', enum: ['short', 'mcq', 'flashcard'] },
              options:  {
                type: 'array', items: { type: 'string' },
                description: 'For mcq only: exactly 4 options, one being the correct answer'
              }
            },
            required: ['question', 'answer', 'type']
          }
        }
      },
      required: ['topicId', 'questions']
    }
  },
  {
    name: 'get_questions',
    description: 'Retrieves all saved questions for a topic. Use to resume a session or drill weak areas.',
    input_schema: {
      type: 'object',
      properties: { topicId: { type: 'string' } },
      required: ['topicId']
    }
  },
  {
    name: 'record_attempt',
    description: 'Records whether the user answered a question correctly. Call after every answer.',
    input_schema: {
      type: 'object',
      properties: {
        questionId: { type: 'string' },
        correct:    { type: 'boolean' }
      },
      required: ['questionId', 'correct']
    }
  },
  {
    name: 'get_topic_progress',
    description: 'Returns accuracy %, questions attempted, and weak questions for a topic.',
    input_schema: {
      type: 'object',
      properties: { topicId: { type: 'string' } },
      required: ['topicId']
    }
  },
  {
    name: 'create_course',
    description: 'Creates a new course or module that groups topics into an ordered syllabus.',
    input_schema: {
      type: 'object',
      properties: {
        name:        { type: 'string', description: 'Course name, e.g. "Biology 101"' },
        description: { type: 'string', description: 'Brief description of what the course covers' }
      },
      required: ['name']
    }
  },
  {
    name: 'list_courses',
    description: 'Lists all saved courses with topic count and completion stats.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_course',
    description: 'Returns a course with its full ordered topic list and per-topic progress. Use before generating a study guide.',
    input_schema: {
      type: 'object',
      properties: { courseId: { type: 'string' } },
      required: ['courseId']
    }
  },
  {
    name: 'add_topic_to_course',
    description: 'Adds an existing topic to a course at a specific position in the syllabus. Call repeatedly to build an ordered syllabus.',
    input_schema: {
      type: 'object',
      properties: {
        courseId:       { type: 'string' },
        topicId:        { type: 'string' },
        position:       { type: 'number', description: '0-indexed position (0 = first)' },
        prerequisiteId: { type: 'string', description: 'Optional: topicId that must be completed first' }
      },
      required: ['courseId', 'topicId', 'position']
    }
  }
];

export async function executeTool(name, input) {
  switch (name) {
    case 'scrape_url':         return scrapeUrl(input.url);
    case 'save_topic':         return saveTopic(input);
    case 'list_topics':        return listTopics();
    case 'get_topic':          return getTopic(input.topicId) || { error: 'Not found' };
    case 'save_questions':     return saveQuestions(input.topicId, input.questions.map(q => ({ ...q, origin: 'ai' })));
    case 'get_questions':      return getQuestions(input.topicId);
    case 'record_attempt':     return recordAttempt(input.questionId, input.correct);
    case 'get_topic_progress': return getTopicProgress(input.topicId);
    case 'create_course':      return createCourse(input);
    case 'list_courses':       return listCourses();
    case 'get_course':         return getCourse(input.courseId) || { error: 'Course not found' };
    case 'add_topic_to_course': return addTopicToCourse(input);
    default:                   return { error: `Unknown tool: ${name}` };
  }
}
