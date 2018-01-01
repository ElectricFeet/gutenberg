/**
 * External dependencies
 */
import optimist from 'redux-optimist';
import { combineReducers } from 'redux';
import {
	flow,
	partialRight,
	get,
	reduce,
	keyBy,
	first,
	last,
	omit,
	without,
	mapValues,
	findIndex,
	reject,
	isEqual,
} from 'lodash';

/**
 * Internal dependencies
 */
import withHistory from '../utils/with-history';
import withChangeDetection from '../utils/with-change-detection';
import { PREFERENCES_DEFAULTS } from './defaults';

/**
 * Returns a post attribute value, flattening nested rendered content using its
 * raw value in place of its original object form.
 *
 * @param  {*} value Original value
 * @return {*}       Raw value
 */
export function getPostRawValue( value ) {
	if ( value && 'object' === typeof value && 'raw' in value ) {
		return value.raw;
	}

	return value;
}

/**
 * Undoable reducer returning the editor post state, including blocks parsed
 * from current HTML markup.
 *
 * Handles the following state keys:
 *  - edits: an object describing changes to be made to the current post, in
 *           the format accepted by the WP REST API
 *  - blocksByUid: post content blocks keyed by UID
 *  - blockOrder: list of block UIDs in order
 *
 * @param  {Object} state  Current state
 * @param  {Object} action Dispatched action
 * @return {Object}        Updated state
 */
export const editor = flow( [
	combineReducers,

	// Track undo history, starting at editor initialization.
	partialRight( withHistory, { resetTypes: [ 'SETUP_EDITOR' ] } ),

	// Track whether changes exist, starting at editor initialization and
	// resetting at each post save.
	partialRight( withChangeDetection, { resetTypes: [ 'SETUP_EDITOR', 'RESET_POST' ] } ),
] )( {
	edits( state = {}, action ) {
		switch ( action.type ) {
			case 'EDIT_POST':
			case 'SETUP_NEW_POST':
				return reduce( action.edits, ( result, value, key ) => {
					// Only assign into result if not already same value
					if ( value !== state[ key ] ) {
						// Avoid mutating original state by creating shallow
						// clone. Should only occur once per reduce.
						if ( result === state ) {
							result = { ...state };
						}

						result[ key ] = value;
					}

					return result;
				}, state );

			case 'RESET_BLOCKS':
				if ( 'content' in state ) {
					return omit( state, 'content' );
				}

				return state;

			case 'RESET_POST':
				return reduce( state, ( result, value, key ) => {
					if ( value !== getPostRawValue( action.post[ key ] ) ) {
						return result;
					}

					if ( state === result ) {
						result = { ...state };
					}

					delete result[ key ];
					return result;
				}, state );
		}

		return state;
	},

	blocksByUid( state = {}, action ) {
		switch ( action.type ) {
			case 'RESET_BLOCKS':
				return keyBy( action.blocks, 'uid' );

			case 'UPDATE_BLOCK_ATTRIBUTES':
				// Ignore updates if block isn't known
				if ( ! state[ action.uid ] ) {
					return state;
				}

				// Consider as updates only changed values
				const nextAttributes = reduce( action.attributes, ( result, value, key ) => {
					if ( value !== result[ key ] ) {
						// Avoid mutating original block by creating shallow clone
						if ( result === state[ action.uid ].attributes ) {
							result = { ...result };
						}

						result[ key ] = value;
					}

					return result;
				}, state[ action.uid ].attributes );

				// Skip update if nothing has been changed. The reference will
				// match the original block if `reduce` had no changed values.
				if ( nextAttributes === state[ action.uid ].attributes ) {
					return state;
				}

				// Otherwise merge attributes into state
				return {
					...state,
					[ action.uid ]: {
						...state[ action.uid ],
						attributes: nextAttributes,
					},
				};

			case 'UPDATE_BLOCK':
				// Ignore updates if block isn't known
				if ( ! state[ action.uid ] ) {
					return state;
				}

				return {
					...state,
					[ action.uid ]: {
						...state[ action.uid ],
						...action.updates,
					},
				};

			case 'INSERT_BLOCKS':
				return {
					...state,
					...keyBy( action.blocks, 'uid' ),
				};

			case 'REPLACE_BLOCKS':
				if ( ! action.blocks ) {
					return state;
				}
				return action.blocks.reduce( ( memo, block ) => {
					return {
						...memo,
						[ block.uid ]: block,
					};
				}, omit( state, action.uids ) );

			case 'REMOVE_BLOCKS':
				return omit( state, action.uids );

			case 'SAVE_REUSABLE_BLOCK_SUCCESS': {
				const { id, updatedId } = action;

				// If a temporary reusable block is saved, we swap the temporary id with the final one
				if ( id === updatedId ) {
					return state;
				}

				return mapValues( state, ( block ) => {
					if ( block.name === 'core/block' && block.attributes.ref === id ) {
						return {
							...block,
							attributes: {
								...block.attributes,
								ref: updatedId,
							},
						};
					}

					return block;
				} );
			}
		}

		return state;
	},

	blockOrder( state = [], action ) {
		switch ( action.type ) {
			case 'RESET_BLOCKS':
				return action.blocks.map( ( { uid } ) => uid );

			case 'INSERT_BLOCKS': {
				const position = action.position !== undefined ? action.position : state.length;
				return [
					...state.slice( 0, position ),
					...action.blocks.map( block => block.uid ),
					...state.slice( position ),
				];
			}

			case 'MOVE_BLOCKS_UP': {
				const firstUid = first( action.uids );
				const lastUid = last( action.uids );

				if ( ! state.length || firstUid === first( state ) ) {
					return state;
				}

				const firstIndex = state.indexOf( firstUid );
				const lastIndex = state.indexOf( lastUid );
				const swappedUid = state[ firstIndex - 1 ];

				return [
					...state.slice( 0, firstIndex - 1 ),
					...action.uids,
					swappedUid,
					...state.slice( lastIndex + 1 ),
				];
			}

			case 'MOVE_BLOCKS_DOWN': {
				const firstUid = first( action.uids );
				const lastUid = last( action.uids );

				if ( ! state.length || lastUid === last( state ) ) {
					return state;
				}

				const firstIndex = state.indexOf( firstUid );
				const lastIndex = state.indexOf( lastUid );
				const swappedUid = state[ lastIndex + 1 ];

				return [
					...state.slice( 0, firstIndex ),
					swappedUid,
					...action.uids,
					...state.slice( lastIndex + 2 ),
				];
			}

			case 'REPLACE_BLOCKS':
				if ( ! action.blocks ) {
					return state;
				}

				return state.reduce( ( memo, uid ) => {
					if ( uid === action.uids[ 0 ] ) {
						return memo.concat( action.blocks.map( ( block ) => block.uid ) );
					}
					if ( action.uids.indexOf( uid ) === -1 ) {
						memo.push( uid );
					}
					return memo;
				}, [] );

			case 'REMOVE_BLOCKS':
				return without( state, ...action.uids );
		}

		return state;
	},
} );

/**
 * Reducer returning the last-known state of the current post, in the format
 * returned by the WP REST API.
 *
 * @param  {Object} state  Current state
 * @param  {Object} action Dispatched action
 * @return {Object}        Updated state
 */
export function currentPost( state = {}, action ) {
	switch ( action.type ) {
		case 'RESET_POST':
		case 'UPDATE_POST':
			let post;
			if ( action.post ) {
				post = action.post;
			} else if ( action.edits ) {
				post = {
					...state,
					...action.edits,
				};
			} else {
				return state;
			}

			return mapValues( post, getPostRawValue );
	}

	return state;
}

/**
 * Reducer returning typing state.
 *
 * @param  {Boolean} state  Current state
 * @param  {Object}  action Dispatched action
 * @return {Boolean}        Updated state
 */
export function isTyping( state = false, action ) {
	switch ( action.type ) {
		case 'START_TYPING':
			return true;

		case 'STOP_TYPING':
			return false;
	}

	return state;
}

/**
 * Reducer returning the block selection's state.
 *
 * @param  {Object} state  Current state
 * @param  {Object} action Dispatched action
 * @return {Object}        Updated state
 */
export function blockSelection( state = {
	start: null,
	end: null,
	focus: null,
	isMultiSelecting: false,
	isEnabled: true,
}, action ) {
	switch ( action.type ) {
		case 'CLEAR_SELECTED_BLOCK':
			return {
				...state,
				start: null,
				end: null,
				focus: null,
				isMultiSelecting: false,
			};
		case 'START_MULTI_SELECT':
			return {
				...state,
				isMultiSelecting: true,
			};
		case 'STOP_MULTI_SELECT':
			return {
				...state,
				isMultiSelecting: false,
				focus: state.start === state.end ? state.focus : null,
			};
		case 'MULTI_SELECT':
			return {
				...state,
				start: action.start,
				end: action.end,
				focus: state.isMultiSelecting ? state.focus : null,
			};
		case 'SELECT_BLOCK':
			if ( action.uid === state.start && action.uid === state.end ) {
				return state;
			}
			return {
				...state,
				start: action.uid,
				end: action.uid,
				focus: action.focus || {},
			};
		case 'UPDATE_FOCUS':
			return {
				...state,
				start: action.uid,
				end: action.uid,
				focus: action.config || {},
			};
		case 'INSERT_BLOCKS':
			return {
				...state,
				start: action.blocks[ 0 ].uid,
				end: action.blocks[ 0 ].uid,
				focus: {},
				isMultiSelecting: false,
			};
		case 'REPLACE_BLOCKS':
			if ( ! action.blocks || ! action.blocks.length || action.uids.indexOf( state.start ) === -1 ) {
				return state;
			}
			return {
				...state,
				start: action.blocks[ 0 ].uid,
				end: action.blocks[ 0 ].uid,
				focus: {},
				isMultiSelecting: false,
			};
		case 'TOGGLE_SELECTION':
			return {
				...state,
				isEnabled: action.isSelectionEnabled,
			};
	}

	return state;
}

/**
 * Reducer returning hovered block state.
 *
 * @param  {Object} state  Current state
 * @param  {Object} action Dispatched action
 * @return {Object}        Updated state
 */
export function hoveredBlock( state = null, action ) {
	switch ( action.type ) {
		case 'TOGGLE_BLOCK_HOVERED':
			return action.hovered ? action.uid : null;
		case 'SELECT_BLOCK':
		case 'START_TYPING':
		case 'MULTI_SELECT':
			return null;
		case 'REPLACE_BLOCKS':
			if ( ! action.blocks || ! action.blocks.length || action.uids.indexOf( state ) === -1 ) {
				return state;
			}

			return action.blocks[ 0 ].uid;
	}

	return state;
}

export function blocksMode( state = {}, action ) {
	if ( action.type === 'TOGGLE_BLOCK_MODE' ) {
		const { uid } = action;
		return {
			...state,
			[ uid ]: state[ uid ] && state[ uid ] === 'html' ? 'visual' : 'html',
		};
	}

	return state;
}

/**
 * Reducer returning the block insertion point
 *
 * @param  {Object} state  Current state
 * @param  {Object} action Dispatched action
 * @return {Object}        Updated state
 */
export function blockInsertionPoint( state = {}, action ) {
	switch ( action.type ) {
		case 'SHOW_INSERTION_POINT':
			return { ...state, visible: true, position: action.index };

		case 'HIDE_INSERTION_POINT':
			return { ...state, visible: false, position: null };
	}

	return state;
}

/**
 * Reducer returning the user preferences:
 *
 * @param  {Object}  state                 Current state
 * @param  {string}  state.mode            Current editor mode, either "visual" or "text".
 * @param  {Boolean} state.isSidebarOpened Whether the sidebar is opened or closed
 * @param  {Object}  state.panels          The state of the different sidebar panels
 * @param  {Object}  action                Dispatched action
 * @return {string}                        Updated state
 */
export function preferences( state = PREFERENCES_DEFAULTS, action ) {
	switch ( action.type ) {
		case 'TOGGLE_SIDEBAR':
			return {
				...state,
				sidebars: {
					...state.sidebars,
					[ action.sidebar ]: action.force !== undefined ? action.force : ! state.sidebars[ action.sidebar ],
				},
			};
		case 'TOGGLE_SIDEBAR_PANEL':
			return {
				...state,
				panels: {
					...state.panels,
					[ action.panel ]: ! get( state, [ 'panels', action.panel ], false ),
				},
			};
		case 'SWITCH_MODE':
			return {
				...state,
				mode: action.mode,
			};
		case 'INSERT_BLOCKS':
			return action.blocks.reduce( ( prevState, block ) => {
				const insert = { name: block.name, initialAttributes: block.attributes };
				const key = JSON.stringify( insert );
				return {
					...prevState,
					recentInserts: [
						insert,
						...reject( prevState.recentInserts, recentInsert => isEqual( insert, recentInsert ) ),
					],
					insertFrequency: {
						...prevState.insertFrequency,
						[ key ]: ( prevState.insertFrequency[ key ] || 0 ) + 1,
					},
				};
			}, state );
		case 'TOGGLE_FEATURE':
			return {
				...state,
				features: {
					...state.features,
					[ action.feature ]: ! state.features[ action.feature ],
				},
			};
	}

	return state;
}

export function panel( state = 'document', action ) {
	switch ( action.type ) {
		case 'SET_ACTIVE_PANEL':
			return action.panel;
	}

	return state;
}

/**
 * Reducer returning current network request state (whether a request to the WP
 * REST API is in progress, successful, or failed).
 *
 * @param  {Object} state  Current state
 * @param  {Object} action Dispatched action
 * @return {Object}        Updated state
 */
export function saving( state = {}, action ) {
	switch ( action.type ) {
		case 'REQUEST_POST_UPDATE':
			return {
				requesting: true,
				successful: false,
				error: null,
			};

		case 'REQUEST_POST_UPDATE_SUCCESS':
			return {
				requesting: false,
				successful: true,
				error: null,
			};

		case 'REQUEST_POST_UPDATE_FAILURE':
			return {
				requesting: false,
				successful: false,
				error: action.error,
			};
	}

	return state;
}

export function notices( state = [], action ) {
	switch ( action.type ) {
		case 'CREATE_NOTICE':
			return [
				...reject( state, { id: action.notice.id } ),
				action.notice,
			];

		case 'REMOVE_NOTICE':
			const { noticeId } = action;
			const index = findIndex( state, { id: noticeId } );
			if ( index === -1 ) {
				return state;
			}

			return [
				...state.slice( 0, index ),
				...state.slice( index + 1 ),
			];
	}

	return state;
}

const locations = [
	'normal',
	'side',
	'advanced',
];

const defaultMetaBoxState = locations.reduce( ( result, key ) => {
	result[ key ] = {
		isActive: false,
		isDirty: false,
		isUpdating: false,
	};

	return result;
}, {} );

export function metaBoxes( state = defaultMetaBoxState, action ) {
	switch ( action.type ) {
		case 'INITIALIZE_META_BOX_STATE':
			return locations.reduce( ( newState, location ) => {
				newState[ location ] = {
					...state[ location ],
					isLoaded: false,
					isActive: action.metaBoxes[ location ],
				};
				return newState;
			}, { ...state } );
		case 'META_BOX_LOADED':
			return {
				...state,
				[ action.location ]: {
					...state[ action.location ],
					isLoaded: true,
					isUpdating: false,
					isDirty: false,
				},
			};
		case 'HANDLE_META_BOX_RELOAD':
			return {
				...state,
				[ action.location ]: {
					...state[ action.location ],
					isUpdating: false,
					isDirty: false,
				},
			};
		case 'REQUEST_META_BOX_UPDATES':
			return action.locations.reduce( ( newState, location ) => {
				newState[ location ] = {
					...state[ location ],
					isUpdating: true,
					isDirty: false,
				};
				return newState;
			}, { ...state } );
		case 'META_BOX_STATE_CHANGED':
			return {
				...state,
				[ action.location ]: {
					...state[ action.location ],
					isDirty: action.hasChanged,
				},
			};
		default:
			return state;
	}
}

export function mobile( state = false, action ) {
	if ( action.type === 'UPDATE_MOBILE_STATE' ) {
		return action.isMobile;
	}
	return state;
}

export const reusableBlocks = combineReducers( {
	data( state = {}, action ) {
		switch ( action.type ) {
			case 'FETCH_REUSABLE_BLOCKS_SUCCESS': {
				return reduce( action.reusableBlocks, ( newState, reusableBlock ) => ( {
					...newState,
					[ reusableBlock.id ]: reusableBlock,
				} ), state );
			}

			case 'UPDATE_REUSABLE_BLOCK': {
				const { id, reusableBlock } = action;
				const existingReusableBlock = state[ id ];

				return {
					...state,
					[ id ]: {
						...existingReusableBlock,
						...reusableBlock,
						attributes: {
							...( existingReusableBlock && existingReusableBlock.attributes ),
							...reusableBlock.attributes,
						},
					},
				};
			}

			case 'SAVE_REUSABLE_BLOCK_SUCCESS': {
				const { id, updatedId } = action;

				// If a temporary reusable block is saved, we swap the temporary id with the final one
				if ( id === updatedId ) {
					return state;
				}
				return {
					...omit( state, id ),
					[ updatedId ]: {
						...omit( state[ id ], [ 'id', 'isTemporary' ] ),
						id: updatedId,
					},
				};
			}
		}

		return state;
	},

	isSaving( state = {}, action ) {
		switch ( action.type ) {
			case 'SAVE_REUSABLE_BLOCK':
				return {
					...state,
					[ action.id ]: true,
				};

			case 'SAVE_REUSABLE_BLOCK_SUCCESS':
			case 'SAVE_REUSABLE_BLOCK_FAILURE': {
				const { id } = action;
				return omit( state, id );
			}
		}

		return state;
	},
} );

export default optimist( combineReducers( {
	editor,
	currentPost,
	isTyping,
	blockSelection,
	hoveredBlock,
	blocksMode,
	blockInsertionPoint,
	preferences,
	panel,
	saving,
	notices,
	metaBoxes,
	mobile,
	reusableBlocks,
} ) );
