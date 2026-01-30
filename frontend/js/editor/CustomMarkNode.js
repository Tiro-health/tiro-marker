/**
 * Custom MarkNode that adds data-lexical-mark-ids attribute to DOM
 * This extends the base MarkNode to expose mark IDs in the DOM for styling and click handling
 */

import { MarkNode } from '@lexical/mark';

export class CustomMarkNode extends MarkNode {
  static getType() {
    return 'mark';
  }

  static clone(node) {
    return new CustomMarkNode(Array.from(node.__ids), node.__key);
  }

  createDOM(config) {
    const element = super.createDOM(config);
    // Add the mark IDs as a data attribute
    element.setAttribute('data-lexical-mark-ids', this.__ids.join(' '));
    return element;
  }

  updateDOM(prevNode, element, config) {
    const result = super.updateDOM(prevNode, element, config);
    // Update the mark IDs attribute
    element.setAttribute('data-lexical-mark-ids', this.__ids.join(' '));
    return result;
  }

  static importJSON(serializedNode) {
    const node = $createCustomMarkNode(serializedNode.ids);
    return node;
  }

  exportJSON() {
    return {
      ...super.exportJSON(),
      type: 'mark',
    };
  }
}

export function $createCustomMarkNode(ids) {
  return new CustomMarkNode(ids);
}

export function $isCustomMarkNode(node) {
  return node instanceof CustomMarkNode;
}
