import { walkGet } from "./utils";
import { VUEXFIRE_ARRAY_ADD, VUEXFIRE_ARRAY_REMOVE } from "./types";

const commitOptions = { root: true };
// Firebase binding
const subscriptions = [];
const defaultOptions = {
  maxRefDepth: 2,
  limit: 4,
  orderBy: null,
  orderDirection: null
};
function bindDocument({ vm, key, docRef, commit }) {
  const target = walkGet(vm, key);
  const ref = docRef.onSnapshot(doc => {
    const changedIndex = subscriptions[key].refList.findIndex(
      refListItem => refListItem.id === doc.id
    );
    if (doc.exists) {
      const data = { ...{ docId: doc.id }, ...doc.data() };
      // add new doc
      if (changedIndex === -1) {
        subscriptions[key].refList.push({
          id: doc.id,
          ref
        });
        commit(
          VUEXFIRE_ARRAY_ADD,
          {
            target,
            newIndex: subscriptions[key].refList.length,
            data
          },
          commitOptions
        );
      } else {
        // edit existing doc
        commit(
          VUEXFIRE_ARRAY_REMOVE,
          { target, oldIndex: changedIndex },
          commitOptions
        );
        commit(
          VUEXFIRE_ARRAY_ADD,
          { target, newIndex: changedIndex, data },
          commitOptions
        );
      }
    } else {
      // delete doc
      commit(
        VUEXFIRE_ARRAY_REMOVE,
        { target, oldIndex: changedIndex },
        commitOptions
      );
      // unsubscribe deleted doc
      subscriptions[key].refList.splice(changedIndex, 1)[0].ref();
    }
  });
}
function bindCollection({ vm, key, collection, commit, resolve, reject }) {
  let isLoaded;
  collection = collection.limit(subscriptions[key].options.limit);
  // get all doc here and save into subscription folder
  const unbind = collection.onSnapshot(ref => {
    const docChanges =
      typeof ref.docChanges === "function" ? ref.docChanges() : ref.docChanges;

    if (!isLoaded && docChanges.length) {
      docChanges.forEach(change => {
        // only add the new doc here
        const isAdded = subscriptions[key].refList.some(
          ref => ref.id === change.doc.id
        );
        // doc not exists in state yet
        if (change.type === "added" && !isAdded) {
          bindDocument({ vm, key, docRef: change.doc.ref, commit });
        }
      });
    }
    // if the pagination mode is on, then ignore all the new node after the first time
    // also, unsubscribe for new node
    isLoaded = true;
    unbind();
    // add next ref here
    if (docChanges.length) {
      const nextDoc = docChanges[docChanges.length - 1];
      subscriptions[key].nextRef = subscriptions[key].ref.startAfter(
        nextDoc.doc
      );
    }
    // resolves when array is empty
    if (!docChanges.length) {
      resolve();
    }
  }, reject);
  return () => {
    unbind();
    subscriptions[key].refList.forEach(refListItem => refListItem.ref());
  };
}
export function bind({ state, commit, key, ref }, options = {}) {
  // merge the options here
  options = { ...defaultOptions, ...options };
  // create an entry for the collection
  // actually bind should be called once (!?)
  if (!subscriptions[key]) {
    subscriptions[key] = {
      ref,
      refList: [],
      nextRef: null,
      options
    };
  }

  return new Promise((resolve, reject) => {
    // is collection
    if (subscriptions[key].ref.where) {
      return bindCollection(
        {
          vm: state,
          key,
          collection: ref,
          commit,
          resolve,
          reject
        },
        subscriptions[key].options
      );
    }
    resolve();
  });
}
export function unbind({ commit, key }) {
  let sub = subscriptions[key];
  if (!sub) return;
  if (sub[key].nextRef) sub[key].nextRef();
  sub[key].refList.forEach(ref => ref());
  delete sub[key];
}
export function fetchNextRef({ state, commit, key }) {
  if (subscriptions[key].nextRef) {
    return new Promise((resolve, reject) => {
      return bindCollection({
        vm: state,
        key,
        collection: subscriptions[key].nextRef,
        commit,
        resolve,
        reject
      });
    });
  }
  return new Promise(() => {});
}
