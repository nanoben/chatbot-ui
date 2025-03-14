import { IconClearAll, IconSettings } from '@tabler/icons-react';
import {
  MutableRefObject,
  memo,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import toast from 'react-hot-toast';

import { useTranslation } from 'next-i18next';

import { getEndpoint } from '@/utils/app/api';
import {
  saveConversation,
  saveConversations,
  updateConversation,
} from '@/utils/app/conversation';
import { throttle } from '@/utils/data/throttle';

import { ChatBody, Conversation, Message } from '@/types/chat';
import { Plugin } from '@/types/plugin';

import HomeContext from '@/pages/api/home/home.context';

import Spinner from '../Spinner';
import { ChatInput } from './ChatInput';
import { ChatLoader } from './ChatLoader';
import { ErrorMessageDiv } from './ErrorMessageDiv';
import { ModelSelect } from './ModelSelect';
import { SystemPrompt } from './SystemPrompt';
import { TemperatureSlider } from './Temperature';
import { MemoizedChatMessage } from './MemoizedChatMessage';

interface Props {
  stopConversationRef: MutableRefObject<boolean>;
}

export const Chat = memo(({ stopConversationRef }: Props) => {
  const { t } = useTranslation('chat');

  // New state variables for authentication
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(false);
  const [password, setPassword] = useState<string>("");
  const [loginError, setLoginError] = useState<string | null>(null);

  const {
    state: {
      selectedConversation,
      conversations,
      models,
      apiKey,
      pluginKeys,
      serverSideApiKeyIsSet,
      messageIsStreaming,
      modelError,
      loading,
      prompts,
    },
    handleUpdateConversation,
    dispatch: homeDispatch,
  } = useContext(HomeContext);

  const [currentMessage, setCurrentMessage] = useState<Message>();
  const [autoScrollEnabled, setAutoScrollEnabled] = useState<boolean>(true);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [showScrollDownButton, setShowScrollDownButton] =
    useState<boolean>(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Additional function for handling login
  const handleLogin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    // Create a new TextEncoder to convert the password to bytes
    const encoder = new TextEncoder();
    const data = encoder.encode(password);

    // Hash the password
    const hashedPassword = await window.crypto.subtle.digest('SHA-256', data);

    // Convert the hash to a hexadecimal string
    const hashArray = Array.from(new Uint8Array(hashedPassword));
    const hashedPasswordHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    try {
      const response = await fetch("https://tekstai.dk/api/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: hashedPasswordHex }),
      });
      if (response.ok) {
        setIsLoggedIn(true);
        setLoginError(null);
        localStorage.setItem('isLoggedIn', 'true');  // Save login status in local storage
      } else {
        throw new Error("Invalid password.");
      }
    } catch (err) {
      setLoginError(String(err));
    }
  };




  const handleSend = useCallback(
    async (message: Message, deleteCount = 0, plugin: Plugin | null = null) => {
      if (selectedConversation) {
        let updatedConversation: Conversation;
        if (deleteCount) {
          const updatedMessages = [...selectedConversation.messages];
          for (let i = 0; i < deleteCount; i++) {
            updatedMessages.pop();
          }
          updatedConversation = {
            ...selectedConversation,
            messages: [...updatedMessages, message],
          };
        } else {
          updatedConversation = {
            ...selectedConversation,
            messages: [...selectedConversation.messages, message],
          };
        }
        homeDispatch({
          field: 'selectedConversation',
          value: updatedConversation,
        });
        homeDispatch({ field: 'loading', value: true });
        homeDispatch({ field: 'messageIsStreaming', value: true });
        const chatBody: ChatBody = {
          model: updatedConversation.model,
          messages: updatedConversation.messages,
          key: apiKey,
          prompt: updatedConversation.prompt,
          temperature: updatedConversation.temperature,
        };
        const endpoint = getEndpoint(plugin);
        let body;
        if (!plugin) {
          body = JSON.stringify(chatBody);
        } else {
          body = JSON.stringify({
            ...chatBody,
            googleAPIKey: pluginKeys
              .find((key) => key.pluginId === 'google-search')
              ?.requiredKeys.find((key) => key.key === 'GOOGLE_API_KEY')?.value,
            googleCSEId: pluginKeys
              .find((key: { pluginId: string; }) => key.pluginId === 'google-search')
              ?.requiredKeys.find((key) => key.key === 'GOOGLE_CSE_ID')?.value,
          });
        }
        const controller = new AbortController();
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
          body,
        });
        if (!response.ok) {
          homeDispatch({ field: 'loading', value: false });
          homeDispatch({ field: 'messageIsStreaming', value: false });
          toast.error(response.statusText);
          return;
        }
        const data = response.body;
        if (!data) {
          homeDispatch({ field: 'loading', value: false });
          homeDispatch({ field: 'messageIsStreaming', value: false });
          return;
        }
        if (!plugin) {
          if (updatedConversation.messages.length === 1) {
            const { content } = message;
            const customName =
              content.length > 30 ? content.substring(0, 30) + '...' : content;
            updatedConversation = {
              ...updatedConversation,
              name: customName,
            };
          }
          homeDispatch({ field: 'loading', value: false });
          const reader = data.getReader();
          const decoder = new TextDecoder();
          let done = false;
          let isFirst = true;
          let text = '';
          while (!done) {
            if (stopConversationRef.current === true) {
              controller.abort();
              done = true;
              break;
            }
            const { value, done: doneReading } = await reader.read();
            done = doneReading;
            const chunkValue = decoder.decode(value);
            text += chunkValue;
            if (isFirst) {
              isFirst = false;
              const updatedMessages: Message[] = [
                ...updatedConversation.messages,
                { role: 'assistant', content: chunkValue },
              ];
              updatedConversation = {
                ...updatedConversation,
                messages: updatedMessages,
              };
              homeDispatch({
                field: 'selectedConversation',
                value: updatedConversation,
              });
            } else {
              const updatedMessages: Message[] =
                updatedConversation.messages.map((message, index) => {
                  if (index === updatedConversation.messages.length - 1) {
                    return {
                      ...message,
                      content: text,
                    };
                  }
                  return message;
                });
              updatedConversation = {
                ...updatedConversation,
                messages: updatedMessages,
              };
              homeDispatch({
                field: 'selectedConversation',
                value: updatedConversation,
              });
            }
          }
          saveConversation(updatedConversation);
          const updatedConversations: Conversation[] = conversations.map(
            (conversation) => {
              if (conversation.id === selectedConversation.id) {
                return updatedConversation;
              }
              return conversation;
            },
          );
          if (updatedConversations.length === 0) {
            updatedConversations.push(updatedConversation);
          }
          homeDispatch({ field: 'conversations', value: updatedConversations });
          saveConversations(updatedConversations);
          homeDispatch({ field: 'messageIsStreaming', value: false });
        } else {
          const { answer } = await response.json();
          const updatedMessages: Message[] = [
            ...updatedConversation.messages,
            { role: 'assistant', content: answer },
          ];
          updatedConversation = {
            ...updatedConversation,
            messages: updatedMessages,
          };
          homeDispatch({
            field: 'selectedConversation',
            value: updateConversation,
          });
          saveConversation(updatedConversation);
          const updatedConversations: Conversation[] = conversations.map(
            (conversation) => {
              if (conversation.id === selectedConversation.id) {
                return updatedConversation;
              }
              return conversation;
            },
          );
          if (updatedConversations.length === 0) {
            updatedConversations.push(updatedConversation);
          }
          homeDispatch({ field: 'conversations', value: updatedConversations });
          saveConversations(updatedConversations);
          homeDispatch({ field: 'loading', value: false });
          homeDispatch({ field: 'messageIsStreaming', value: false });
        }
      }
    },
    [
      apiKey,
      conversations,
      pluginKeys,
      selectedConversation,
      stopConversationRef,
    ],
  );

  const scrollToBottom = useCallback(() => {
    if (autoScrollEnabled) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      textareaRef.current?.focus();
    }
  }, [autoScrollEnabled]);

  const handleScroll = () => {
    if (chatContainerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } =
        chatContainerRef.current;
      const bottomTolerance = 30;

      if (scrollTop + clientHeight < scrollHeight - bottomTolerance) {
        setAutoScrollEnabled(false);
        setShowScrollDownButton(true);
      } else {
        setAutoScrollEnabled(true);
        setShowScrollDownButton(false);
      }
    }
  };

  const handleScrollDown = () => {
    chatContainerRef.current?.scrollTo({
      top: chatContainerRef.current.scrollHeight,
      behavior: 'smooth',
    });
  };

  const handleSettings = () => {
    setShowSettings(!showSettings);
  };

  const onClearAll = () => {
    if (
      confirm(t<string>('Are you sure you want to clear all messages?')) &&
      selectedConversation
    ) {
      handleUpdateConversation(selectedConversation, {
        key: 'messages',
        value: [],
      });
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('isLoggedIn');
    homeDispatch({ field: 'conversations', value: [] });
    window.location.reload();
  };

  const scrollDown = () => {
    if (autoScrollEnabled) {
      messagesEndRef.current?.scrollIntoView(true);
    }
  };
  const throttledScrollDown = throttle(scrollDown, 250);

  useEffect(() => {
    // On initial load, check if user is already logged in
    if (localStorage.getItem('isLoggedIn') === 'true') {
      setIsLoggedIn(true);
    }
  }, []);



  // useEffect(() => {
  //   console.log('currentMessage', currentMessage);
  //   if (currentMessage) {
  //     handleSend(currentMessage);
  //     homeDispatch({ field: 'currentMessage', value: undefined });
  //   }
  // }, [currentMessage]);

  useEffect(() => {
    throttledScrollDown();
    selectedConversation &&
      setCurrentMessage(
        selectedConversation.messages[selectedConversation.messages.length - 2],
      );
  }, [selectedConversation, throttledScrollDown]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        setAutoScrollEnabled(entry.isIntersecting);
        if (entry.isIntersecting) {
          textareaRef.current?.focus();
        }
      },
      {
        root: null,
        threshold: 0.5,
      },
    );
    const messagesEndElement = messagesEndRef.current;
    if (messagesEndElement) {
      observer.observe(messagesEndElement);
    }
    return () => {
      if (messagesEndElement) {
        observer.unobserve(messagesEndElement);
      }
    };
  }, [messagesEndRef]);

  return (
    <div className="relative flex-1 overflow-hidden bg-white dark:bg-[#343541]">
      {!isLoggedIn ? (

        <div className="mx-auto flex h-full w-[300px] flex-col justify-center space-y-6 sm:w-[600px]">
          <div className="text-center text-4xl font-bold text-black dark:text-white">
          {t('Welcome to chat.viden.ai!')}
          </div>
          <div className="text-center text-lg text-black dark:text-white">
            <div className="mb-2 font-bold">
              {t('We are pleased to introduce you to our chatbot, which is designed to be fully GDPR compliant and is hosted on European servers to ensure your data remains secure and private.')}
            </div>
          </div>
          <div className="text-center text-gray-500 dark:text-gray-400">
            <div className="mb-2">
              
              {t('Please note that it is important not to enter personally sensitive information in the chat. We are dedicated to protecting your information, but you also have a responsibility to protect your own information.')}

            </div>

            <div className="mb-2">
        
              {t(
                'Our chatbot is also suitable for use in educational contexts, as a tool for understanding and working with AI.'
                )}

            </div>

            <div className="mb-2 font-bold">
            BEMÆRK! <br />Chat.viden.ai er et testsystem (beta-udgave), hvor vi undersøger mulighederne for at skabe en GDPR-compliant version af ChatGPT. Tjenesten kan blive lukket ned uden forudgående varsel og vil løbende blive opdateret.
            </div>
            <div className="mb-2">
              
              {t("It is important to note that our chatbot interface is 100% independent of OpenAI. We have created our own user interface that enables you to work with OpenAI's version 3.5 via Microsoft Azure server. This allows you to take advantage of the latest technology while being confident that your data will remain secure.")}

            </div>            
            <div className="mb-2 font-bold">
              
            {t("To access our chatbot, you need a token. If you don't already have one, you can easily get one by sending an email to kontakt@viden.ai.")}
            <br />Læs om projekt her: <a href='https://viden.ai/pilotprojekt-gdpr-compliance-udgave-af-chatgpt-til-undervisningen/?chat'><u>Pilotprojekt: GDPR compliance-udgave af ChatGPT til undervisningen</u></a>.
          </div>

            
            <div>
              <form onSubmit={handleLogin} className="flex flex-col items-center">


                <input
                  type="text"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  style={{
                    borderRadius: "4px",
                    padding: "10px 15px",
                    fontSize: "1.2em",
                    margin: "10px 0",
                    color: "#3c4047",
                    border: "1px",
                    borderColor: "black"
    }}
  />
                <button
                  type="submit"
                  style={{
                    background: "#3c4047",
                    color: "white",
                    borderRadius: "4px",
                    padding: "10px 15px",
                    fontSize: "1.2em",
                    cursor: "pointer",
                    border: "1px",
                    margin: "10px 0",
                    borderColor: "#3c4047"

    }}
  >
                Log ind
              </button>
              {loginError && <div className="error">{loginError}</div>}
            </form>
          </div>
        </div>
        </div>

  ) : !(apiKey || serverSideApiKeyIsSet) ? (
    <div className="mx-auto flex h-full w-[300px] flex-col justify-center space-y-6 sm:w-[600px]">
      <div className="text-center text-4xl font-bold text-black dark:text-white">
        Welcome to Chatbot UI 
      </div>
      <div className="text-center text-lg text-black dark:text-white">
        <div className="mb-8">{`Chatbot UI is an open source clone of OpenAI's ChatGPT UI.`}</div>
        <div className="mb-2 font-bold">
          Important: Chatbot UI is 100% unaffiliated with OpenAI.
        </div>
      </div>
      <div className="text-center text-gray-500 dark:text-gray-400">
        <div className="mb-2">
          Chatbot UI allows you to plug in your API key to use this UI with
          their API.
        </div>
        <div className="mb-2">
          It is <span className="italic">only</span> used to communicate
          with their API.
        </div>
        <div className="mb-2">
          {t(
            'Please set your OpenAI API key in the bottom left of the sidebar.',
          )}
        </div>
        <div>
          {t("If you don't have an OpenAI API key, you can get one here: ")}
          <a
            href="https://platform.openai.com/account/api-keys"
            target="_blank"
            rel="noreferrer"
            className="text-blue-500 hover:underline"
          >
            openai.com
          </a>
        </div>
      </div>
    </div>
  ) : modelError ? (
    <ErrorMessageDiv error={modelError} />
  ) : (
    <>
      <div
        className="max-h-full overflow-x-hidden"
        ref={chatContainerRef}
        onScroll={handleScroll}
      >
        {selectedConversation?.messages.length === 0 ? (
          <>
            <div className="mx-auto flex flex-col space-y-5 md:space-y-10 px-3 pt-5 md:pt-12 sm:max-w-[600px]">
              <div className="text-center text-3xl font-semibold text-gray-800 dark:text-gray-100">
                {models.length === 0 ? (
                  <div>
                    <Spinner size="16px" className="mx-auto" />
                  </div>
                ) : (
                  'Chat.Viden.AI'
                )}
              </div>

              {models.length > 0 && (
                <div className="flex h-full flex-col space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-600">
                  <ModelSelect />

                  <SystemPrompt
                    conversation={selectedConversation}
                    prompts={prompts}
                    onChangePrompt={(prompt) =>
                      handleUpdateConversation(selectedConversation, {
                        key: 'prompt',
                        value: prompt,
                      })
                    }
                  />

                  <TemperatureSlider
                    label={t('Temperature')}
                    onChangeTemperature={(temperature) =>
                      handleUpdateConversation(selectedConversation, {
                        key: 'temperature',
                        value: temperature,
                      })
                    }
                  />
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="sticky top-0 z-10 flex justify-center border border-b-neutral-300 bg-neutral-100 py-2 text-sm text-neutral-500 dark:border-none dark:bg-[#444654] dark:text-neutral-200">
              {t('Model')}: {selectedConversation?.model.name} | {t('Temp')}
              : {selectedConversation?.temperature} |
              <button
                className="ml-2 cursor-pointer hover:opacity-50"
                onClick={handleSettings}
              >
                <IconSettings size={18} />
              </button>
              <button
                className="ml-2 cursor-pointer hover:opacity-50"
                onClick={onClearAll}
              >
                <IconClearAll size={18} />
              </button>

              <button style={{marginLeft: '20px'}} onClick={handleLogout}> Log ud</button>


            </div>
            {showSettings && (
              <div className="flex flex-col space-y-10 md:mx-auto md:max-w-xl md:gap-6 md:py-3 md:pt-6 lg:max-w-2xl lg:px-0 xl:max-w-3xl">
                <div className="flex h-full flex-col space-y-4 border-b border-neutral-200 p-4 dark:border-neutral-600 md:rounded-lg md:border">
                  <ModelSelect />
                </div>
              </div>
            )}

            {selectedConversation?.messages.map((message, index) => (
              <MemoizedChatMessage
                key={index}
                message={message}
                messageIndex={index}
                onEdit={(editedMessage) => {
                  setCurrentMessage(editedMessage);
                  // discard edited message and the ones that come after then resend
                  handleSend(
                    editedMessage,
                    selectedConversation?.messages.length - index,
                  );
                }}
              />
            ))}

            {loading && <ChatLoader />}

            <div
              className="h-[162px] bg-white dark:bg-[#343541]"
              ref={messagesEndRef}
            />
          </>
        )}
      </div>

      <ChatInput
        stopConversationRef={stopConversationRef}
        textareaRef={textareaRef}
        onSend={(message, plugin) => {
          setCurrentMessage(message);
          handleSend(message, 0, plugin);
        }}
        onScrollDownClick={handleScrollDown}
        onRegenerate={() => {
          if (currentMessage) {
            handleSend(currentMessage, 2, null);
          }
        }}
        showScrollDownButton={showScrollDownButton}
      />
    </>
  )
}
    </div >
  );
});
Chat.displayName = 'Chat';
